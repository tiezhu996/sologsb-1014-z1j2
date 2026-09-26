import { createId, RULES } from './store';
import type { ProofDocument, ProofStep, StepType } from './types';

export type ImportFormat = 'markdown' | 'latex' | 'text';
export type ImportSeverity = 'error' | 'warning' | 'info';

export interface ImportNotice {
  severity: ImportSeverity;
  message: string;
  line?: number;
}

export interface ImportResult {
  format: ImportFormat;
  document: ProofDocument;
  notices: ImportNotice[];
  recoveredSteps: number;
  unparsedChunks: number;
}

/* ------------------------------------------------------------------ */
/* 通用小工具                                                          */
/* ------------------------------------------------------------------ */

const BULLET = /^\s*(?:[-*+•]\s+|\d+[.、)）]\s+)/;
const FIELD_PATTERN = /^\s*(?:[-*+•]\s+)?(?:\*\*|__)?\s*([^*_$\\：:]{1,14}?)\s*(?:\*\*|__)?\s*[：:]\s*(.*)$/;

function cleanInline(text: string): string {
  return text.replace(/^\s*\*\*?/, '').replace(/\*\*?\s*$/, '').trim();
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

/** 从“依据”字段的值里抽出稿面步骤编号，支持“步骤 3、第 4 步、3-5、3～5”等写法。 */
function extractStepNumbers(value: string): number[] {
  let rest = value;
  const numbers: number[] = [];
  const range = /(\d{1,4})\s*(?:[-–—~～]|至|到)\s*(\d{1,4})/g;
  let match: RegExpExecArray | null;
  while ((match = range.exec(rest))) {
    const start = Number(match[1]);
    const end = Number(match[2]);
    if (start <= end && end - start <= 200) {
      for (let n = start; n <= end; n += 1) numbers.push(n);
    }
  }
  rest = rest.replace(range, ' ').replace(/[（(]\s*\d+\s*[)）]/g, ' ');
  const single = /\d{1,4}/g;
  while ((match = single.exec(rest))) numbers.push(Number(match[0]));
  return unique(numbers);
}

/* ------------------------------------------------------------------ */
/* 字段词典                                                            */
/* ------------------------------------------------------------------ */

type FieldKey = 'type' | 'rule' | 'refs' | 'note' | 'ce' | 'alt';

const FIELD_LABELS: Record<string, FieldKey> = {
  类型: 'type',
  步骤类型: 'type',
  类别: 'type',
  种类: 'type',
  type: 'type',
  kind: 'type',
  推理规则: 'rule',
  规则: 'rule',
  所用规则: 'rule',
 使用规则: 'rule',
  依据规则: 'rule',
  rule: 'rule',
  依据: 'refs',
  引用: 'refs',
  引用步骤: 'refs',
  参考: 'refs',
  参考步骤: 'refs',
  前提依据: 'refs',
  references: 'refs',
  refs: 'refs',
  旁注: 'note',
  注释: 'note',
  备注: 'note',
  说明: 'note',
  评语: 'note',
  note: 'note',
  remark: 'note',
  comment: 'note',
  comments: 'note',
  反例: 'ce',
  边界情况: 'ce',
  反例边界情况: 'ce',
  counterexample: 'ce',
  替代分支: 'alt',
  备选分支: 'alt',
  替代方案: 'alt',
  另一种思路: 'alt',
  另一分支: 'alt',
  分支: 'alt',
  alternative: 'alt',
  alternate: 'alt',
};

function matchFieldLabel(label: string): FieldKey | null {
  const normalized = label.replace(/\s+/g, '').replace(/[\/／（）()]/g, '').toLowerCase();
  return FIELD_LABELS[normalized] ?? null;
}

const TYPE_VALUES: Record<string, StepType> = {};
['前提', '已知', '假设', '假定', '条件', 'premise', 'assumption', 'hypothesis', 'given', 'hyp'].forEach((word) => {
  TYPE_VALUES[word] = 'premise';
});
['推导', '推理', '演绎', 'derivation', 'inference', 'deduction', 'derived', 'deduce'].forEach((word) => {
  TYPE_VALUES[word] = 'derivation';
});
['目标', '结论', 'goal', 'conclusion', 'qed', 'q.e.d', 'conclude', 'final'].forEach((word) => {
  TYPE_VALUES[word] = 'goal';
});

function matchType(value: string): StepType | null {
  const tokens = value.split(/[\/／、,，;；\s]+/).map((token) => token.trim().toLowerCase()).filter(Boolean);
  for (const token of tokens) {
    if (TYPE_VALUES[token]) return TYPE_VALUES[token];
  }
  return null;
}

function canonicalRule(value: string): { rule: string; known: boolean } {
  const trimmed = value.trim();
  const hit = RULES.find((rule) => rule === trimmed);
  if (hit) return { rule: hit, known: true };
  const fuzzy = RULES.find((rule) => rule.toLowerCase() === trimmed.toLowerCase());
  if (fuzzy) return { rule: fuzzy, known: true };
  return { rule: trimmed, known: false };
}

/**
 * 命题行里内联的字段，如“$P(n)$ 成立。类型：结论，规则：结论”。
 * 从行尾向前切，只认词典内的中文标签，避免把命题里的冒号误判成字段。
 */
function extractInlineFields(statement: string): { statement: string; fields: { key: FieldKey; value: string }[] } {
  const fields: { key: FieldKey; value: string }[] = [];
  let rest = statement.trim();
  for (let guard = 0; guard < 6; guard += 1) {
    const match = /[，,。;；\s]+([一-龥]{1,6})\s*[：:]\s*([^，,。;；：:]+)$/.exec(rest);
    if (!match) break;
    const key = matchFieldLabel(match[1]);
    if (!key) break;
    fields.unshift({ key, value: match[2].trim().replace(/[。.；;，,]+$/, '') });
    rest = rest.slice(0, match.index).replace(/[，,。;；\s]+$/, '');
  }
  return { statement: rest, fields };
}

/* ------------------------------------------------------------------ */
/* Markdown 解析                                                       */
/* ------------------------------------------------------------------ */

interface PendingStep {
  sourceNo: number | null;
  startLine: number;
  statement: string;
  type: StepType | null;
  rule: string;
  refs: number[];
  notes: string[];
  counterexample: string;
  alternative: string;
  verbatim: string[];
}

type Item = { kind: 'step'; step: PendingStep } | { kind: 'loose'; startLine: number; text: string };

interface StepHeading {
  no: number;
  statement: string;
}

function parseStepHeading(text: string, h1: boolean): StepHeading | null {
  let match: RegExpMatchArray | null;
  if ((match = text.match(/^第\s*0*(\d{1,4})\s*步(?:[\s:：、.．)）\-—]+(.*))?$/))) {
    return { no: Number(match[1]), statement: (match[2] ?? '').trim() };
  }
  if ((match = text.match(/^步骤\s*0*(\d{1,4})(?:[\s:：、.．)）\-—]+(.*))?$/))) {
    return { no: Number(match[1]), statement: (match[2] ?? '').trim() };
  }
  if (h1) return null;
  if ((match = text.match(/^0*(\d{1,4})\s*[.、)）．:：]\s*(.*)$/))) {
    return { no: Number(match[1]), statement: match[2].trim() };
  }
  if ((match = text.match(/^0*(\d{1,4})\s+(\S.*)$/))) {
    return { no: Number(match[1]), statement: match[2].trim() };
  }
  return null;
}

const SYMBOLS_HEADING = /(符号表|符号一览|记号表|记号(?:约定|说明)|notations?|symbols)/i;
const GOAL_HEADING = /^(证明目标|证明命题|要证(?:明)?(?:的命题|结论)?|命题|目标|theorem|goal|claim)\s*[：:]?$/i;
const GOAL_INLINE = /(证明目标|要证(?:明)?(?:的命题|结论)?|命题(?:结论)?|目标|goal|theorem|claim)\s*[：:]\s*(.+)/i;

function tryGoalLine(text: string): string | null {
  const cleaned = cleanInline(text);
  const match = GOAL_INLINE.exec(cleaned);
  if (!match) return null;
  return match[2].replace(/\*\*/g, '').trim();
}

interface HeadingInfo {
  kind: 'step' | 'symbols' | 'goal' | 'other' | 'title';
  text: string;
  step?: StepHeading;
}

function classifyHeading(raw: string): { level: number; info: HeadingInfo } | null {
  let level = 0;
  let text = '';
  const atx = /^(#{1,6})\s+(.*\S.*)$/.exec(raw);
  const trimmed = raw.trim();
  if (atx) {
    level = atx[1].length;
    text = atx[2].trim();
  } else if (/^\*\*[\s\S]+\*\*$/.test(trimmed) || /^__[\s\S]+__$/.test(trimmed)) {
    level = 2;
    text = trimmed.replace(/^\*\*|__/, '').replace(/\*\*$|__$/, '').trim();
  } else {
    const bareStep = /^(?:第?\s*\d{1,4}\s*步|步骤\s*\d{1,4})\s*[：:、.．)）\-—]/.test(trimmed);
    const numbered = /^\d{1,4}\s*[.、)）．:：](?:\s+\S|\s*\$)/.test(trimmed);
    if (bareStep || numbered) {
      level = 9;
      text = trimmed;
    } else {
      return null;
    }
  }

  if (SYMBOLS_HEADING.test(text)) return { level, info: { kind: 'symbols', text } };
  if (GOAL_HEADING.test(text)) {
    const inline = tryGoalLine(text);
    return { level, info: { kind: 'goal', text: inline ?? text } };
  }
  const step = parseStepHeading(text, false);
  if (step) return { level, info: { kind: 'step', text, step } };
  if (level === 1) return { level, info: { kind: 'title', text } };
  return { level, info: { kind: 'other', text } };
}

interface ParsedBody {
  title: string;
  goal: string;
  symbols: Record<string, string>;
  items: Item[];
  notices: ImportNotice[];
}

function parseMarkdown(input: string): ParsedBody {
  const lines = input.replace(/^﻿/, '').split(/\r\n|\r|\n/);
  const notices: ImportNotice[] = [];
  const items: Item[] = [];
  const symbols: Record<string, string> = {};
  let title = '';
  let goal = '';
  let mode: 'normal' | 'body' | 'symbols' | 'goal' = 'normal';
  let current: PendingStep | null = null;
  let looseBuffer: string[] = [];
  let looseStart = 0;
  let stepsSeen = false;
  let symbolLeftovers: string[] = [];
  let lastFieldKey: FieldKey | null = null;
  let fieldsStarted = false;

  const pushNotice = (severity: ImportSeverity, message: string, line?: number) => notices.push({ severity, message, line });

  const flushLoose = () => {
    const text = looseBuffer.join('\n').trim();
    if (text) {
      items.push({ kind: 'loose', startLine: looseStart, text });
      pushNotice('warning', `第 ${looseStart} 行附近有无法识别为步骤字段的内容，已整段原样保留。`, looseStart);
    }
    looseBuffer = [];
  };

  const flushSymbolLeftovers = (lineNo: number) => {
    const text = symbolLeftovers.join('\n').trim();
    if (text) {
      items.push({ kind: 'loose', startLine: lineNo, text });
      pushNotice('warning', '符号表中有无法解析的行，已整段原样保留。', lineNo);
    }
    symbolLeftovers = [];
  };

  const startStep = (heading: StepHeading, lineNo: number) => {
    /* 第一步之前的首行短前言，在没有 # 标题时提升为标题，其余仍原样保留 */
    if (looseBuffer.length && !stepsSeen && !title) {
      const first = looseBuffer.shift() ?? '';
      title = first.trim();
      looseStart = lineNo;
      if (title) pushNotice('info', `已将首行“${title}”视为标题。`, looseStart);
    }
    flushLoose();
    stepsSeen = true;
    current = {
      sourceNo: heading.no,
      startLine: lineNo,
      statement: heading.statement,
      type: null,
      rule: '',
      refs: [],
      notes: [],
      counterexample: '',
      alternative: '',
      verbatim: [],
    };
    items.push({ kind: 'step', step: current });
    mode = 'body';
    lastFieldKey = null;
    fieldsStarted = false;
  };

  const applyField = (key: FieldKey, value: string, lineNo: number) => {
    if (!current) return;
    fieldsStarted = true;
    lastFieldKey = key;
    if (key === 'type') {
      const type = matchType(value);
      if (type) current.type = type;
      else {
        current.verbatim.push(`类型：${value}`);
        pushNotice('warning', `步骤 ${current.sourceNo ?? ''} 的类型“${value.trim()}”无法识别，已原样保留。`, lineNo);
      }
    } else if (key === 'rule') {
      current.rule = value.trim();
    } else if (key === 'refs') {
      current.refs.push(...extractStepNumbers(value));
    } else if (key === 'note') {
      current.notes.push(value.trim());
    } else if (key === 'ce') {
      current.counterexample = [current.counterexample, value.trim()].filter(Boolean).join('\n');
    } else if (key === 'alt') {
      current.alternative = [current.alternative, value.trim()].filter(Boolean).join('\n');
    }
  };

  lines.forEach((raw, index) => {
    const lineNo = index + 1;
    const heading = classifyHeading(raw);

    if (heading) {
      const { info } = heading;
      if (mode === 'symbols') flushSymbolLeftovers(lineNo);
      if (info.kind === 'step' && info.step) {
        startStep(info.step, lineNo);
        return;
      }
      current = null;
      mode = 'normal';
      if (info.kind === 'symbols') mode = 'symbols';
      else if (info.kind === 'goal') {
        mode = 'goal';
        const inlineGoal = tryGoalLine(info.text);
        if (inlineGoal && !goal) goal = inlineGoal;
      } else if (info.kind === 'title') {
        if (!title) title = info.text.replace(/^#+\s*/, '').trim();
      }
      return;
    }

    const isBlank = !raw.trim();
    if (isBlank) return;

    /* 非步骤正文里，优先全局识别证明目标行 */
    if (mode !== 'body') {
      const inlineGoal = tryGoalLine(raw);
      if (inlineGoal && !goal) {
        goal = inlineGoal;
        return;
      }
    }

    if (mode === 'symbols') {
      const bullet = BULLET.exec(raw);
      const content = bullet ? raw.replace(BULLET, '').trim() : raw.trim();
      let pair = /^\$?([^$：:\s][^$：:]{0,12}?)\$?\s*[：:]\s*(.+)$/.exec(content);
      if (!pair) pair = /^\$?([^$：:\s][^$：:]{0,12}?)\$?\s+[—–-]\s+(.+)$/.exec(content);
      if (pair) symbols[pair[1].trim()] = pair[2].trim();
      else symbolLeftovers.push(raw.trim());
      return;
    }

    if (mode === 'goal') {
      if (!goal) goal = cleanInline(raw);
      else looseBuffer.push(raw.trim());
      if (looseBuffer.length === 1) looseStart = lineNo;
      return;
    }

    if (mode === 'body' && current) {
      const field = FIELD_PATTERN.exec(raw);
      const key = field ? matchFieldLabel(field[1]) : null;
      const isIndentedContinuation = /^\s+\S/.test(raw) && lastFieldKey !== null;
      if (key) {
        applyField(key, field![2], lineNo);
        return;
      }
      if (isIndentedContinuation) {
        const value = raw.trim();
        if (lastFieldKey === 'note') current.notes.push(value);
        else if (lastFieldKey === 'ce') current.counterexample = [current.counterexample, value].filter(Boolean).join('\n');
        else if (lastFieldKey === 'alt') current.alternative = [current.alternative, value].filter(Boolean).join('\n');
        else if (lastFieldKey === 'rule') current.rule = `${current.rule} ${value}`;
        else current.verbatim.push(value);
        return;
      }
      lastFieldKey = null;
      const hasBullet = BULLET.test(raw);
      if (!fieldsStarted && !hasBullet) {
        current.statement = [current.statement, raw.trim()].filter(Boolean).join('\n');
      } else {
        current.verbatim.push(hasBullet ? raw.replace(BULLET, '').trim() : raw.trim());
      }
      return;
    }

    /* normal 模式：收集为散段，稍后原样保留 */
    if (looseBuffer.length === 0) looseStart = lineNo;
    looseBuffer.push(raw.trim());
  });

  flushLoose();
  flushSymbolLeftovers(lines.length);

  if (!title) pushNotice('warning', '没有识别到标题（形如“# 标题”），已使用默认标题。');
  if (!goal) pushNotice('warning', '没有识别到证明目标（形如“证明目标：$…$”），导入后请补填。');
  if (!items.some((item) => item.kind === 'step')) {
    pushNotice('warning', '未识别出标准步骤结构，全部内容已按原文保留，可在编辑器里继续整理。');
  }

  return { title, goal, symbols, items, notices };
}

/* ------------------------------------------------------------------ */
/* LaTeX 解析（尽力恢复；LaTeX 导出本身不含旁注/反例/符号表）          */
/* ------------------------------------------------------------------ */

const LATEX_MARKER = /\\(documentclass|begin\s*\{document\}|section\*)/;

function stripLatexBoiler(line: string): string | null {
  const trimmed = line.trim();
  if (/^\\(documentclass|usepackage|begin\{[a-z*]+\}|end\{[a-z*]+\})/.test(trimmed)) return null;
  return trimmed;
}

function parseLatex(input: string): ParsedBody {
  const notices: ImportNotice[] = [];
  const items: Item[] = [];
  const section = /\\section\*\{([^}]*)\}/.exec(input);
  const title = section?.[1]?.trim() ?? '';
  const goalMatch = /(?:证明目标|Goal|Theorem)[^$]*\$([^$]+)\$/.exec(input);
  const goal = goalMatch ? `$${goalMatch[1]}$` : '';
  if (!title) notices.push({ severity: 'warning', message: 'LaTeX 稿中未找到 \\section*{…} 标题。' });
  if (!goal) notices.push({ severity: 'warning', message: 'LaTeX 稿中未找到证明目标，导入后请补填。' });

  const bodyMatch = /\\begin\{enumerate\}([\s\S]*?)\\end\{enumerate\}/.exec(input);
  const leftovers: string[] = [];
  let counter = 0;

  const consumeItem = (raw: string, startLine: number) => {
    counter += 1;
    let text = raw.replace(/^\s*\\item\s*/, '').trim();
    const step: PendingStep = {
      sourceNo: counter,
      startLine,
      statement: '',
      type: null,
      rule: '',
      refs: [],
      notes: [],
      counterexample: '',
      alternative: '',
      verbatim: [],
    };
    const noteParts = text.split(/\\par\s*(?:\\small\s*)?/);
    text = noteParts.shift() ?? text;
    noteParts.forEach((part) => {
      const note = part.replace(/^旁注[：:]\s*/, '').replace(/[\\]?\s*$/, '').trim();
      if (note) step.notes.push(note);
    });
    const support = /[（(]([^（）()]*)[)）]\s*$/.exec(text);
    if (support) {
      text = text.slice(0, support.index).trim();
      support[1].split(/[;；,，]/).map((part) => part.trim()).filter(Boolean).forEach((part) => {
        const refPart = /^(?:依据|引用|from|refs?)\s*[：:]?\s*(.+)$/i.exec(part);
        if (refPart) step.refs.push(...extractStepNumbers(refPart[1]));
        else if (!/^(依据|引用)$/.test(part)) step.rule = part;
      });
    }
    step.statement = text;
    step.type = counter === 1 && !step.refs.length ? 'premise' : 'derivation';
    items.push({ kind: 'step', step });
  };

  if (bodyMatch) {
    const offset = input.slice(0, bodyMatch.index).split(/\r\n|\r|\n/).length;
    const chunks = bodyMatch[1].split(/(?=^\s*\\item\b)/m);
    chunks.forEach((chunk) => {
      const startLine = offset + chunk.slice(0, chunk.search(/\\item/)).split('\n').length;
      const joined = chunk.split(/\r\n|\r|\n/).map((line) => line.trim()).filter(Boolean).join('\n');
      if (/\\item/.test(joined)) consumeItem(joined, startLine);
    });
  }

  input.split(/\r\n|\r|\n/).forEach((line) => {
    const kept = stripLatexBoiler(line);
    if (kept && !kept.startsWith('\\item') && !kept.startsWith('\\par') && !/\\section\*/.test(kept) && !/证明目标/.test(kept)) {
      leftovers.push(kept);
    }
  });
  if (leftovers.length) {
    items.push({ kind: 'loose', startLine: 1, text: leftovers.join('\n') });
    notices.push({ severity: 'warning', message: 'LaTeX 稿中有无法归入步骤的内容，已整段原样保留。' });
  }
  notices.push({ severity: 'info', message: 'LaTeX 导出稿不包含反例、替代分支与符号表，这些字段需要重新补充。' });
  return { title, goal, symbols: {}, items, notices };
}

/* ------------------------------------------------------------------ */
/* 装配：编号重映射 + 容错兜底                                         */
/* ------------------------------------------------------------------ */

function buildResult(body: ParsedBody, format: ImportFormat): ImportResult {
  const notices = body.notices;
  const pending = body.items.map((item) => (item.kind === 'step' ? item.step : null));
  const numberToId = new Map<number, string>();
  const seenNumbers = new Set<number>();

  const steps: ProofStep[] = body.items.map((item) => {
    if (item.kind === 'loose') {
      return {
        id: createId('step'),
        type: 'derivation',
        statement: item.text,
        rule: '',
        references: [],
        note: '〔导入〕此段无法识别为标准证明步骤，已按原文保留，可继续编辑或删除。',
        counterexample: '',
        alternative: '',
      } satisfies ProofStep;
    }
    const p = item.step;
    const id = createId('step');

    /* 命题行内联字段（“……。类型：结论，规则：结论”） */
    const inline = extractInlineFields(p.statement);
    if (inline.fields.length) {
      p.statement = inline.statement;
      inline.fields.forEach(({ key, value }) => {
        if (key === 'type') {
          const type = matchType(value);
          if (type) p.type = type;
          else p.verbatim.push(`类型：${value}`);
        } else if (key === 'rule') p.rule = value;
        else if (key === 'refs') p.refs.push(...extractStepNumbers(value));
        else if (key === 'note') p.notes.push(value);
        else if (key === 'ce') p.counterexample = [p.counterexample, value].filter(Boolean).join('\n');
        else if (key === 'alt') p.alternative = [p.alternative, value].filter(Boolean).join('\n');
      });
    }

    if (p.sourceNo !== null) {
      if (seenNumbers.has(p.sourceNo)) {
        notices.push({ severity: 'warning', message: `稿面步骤编号 ${p.sourceNo} 重复，依据序号只对应第一次出现的步骤。`, line: p.startLine });
      } else {
        seenNumbers.add(p.sourceNo);
        numberToId.set(p.sourceNo, id);
      }
    }
    let type: StepType = p.type ?? 'derivation';
    let rule = p.rule;
    if (!rule) {
      if (type === 'premise') rule = '前提';
      else if (type === 'goal') rule = '结论';
      else {
        rule = '等式变形';
        notices.push({ severity: 'warning', message: `步骤 ${p.sourceNo ?? ''} 没有标注推理规则，已暂填“等式变形”，请核对。`, line: p.startLine });
      }
    }
    if (p.type === null) {
      if (rule === '前提') type = 'premise';
      else if (rule === '结论') type = 'goal';
    }
    return {
      id,
      type,
      statement: p.statement,
      rule,
      references: [],
      note: p.notes.join('\n'),
      counterexample: p.counterexample,
      alternative: p.alternative,
    } satisfies ProofStep;
  });

  /* 依据序号 → 真实步骤 id */
  body.items.forEach((item, index) => {
    if (item.kind !== 'step') return;
    const p = item.step;
    const target = steps[index];
    const refs: string[] = [];
    unique(p.refs).forEach((no) => {
      const id = numberToId.get(no);
      if (id && !refs.includes(id)) refs.push(id);
      else {
        const raw = `〔原稿〕依据：步骤 ${no}（原稿有此引用，但读回时找不到对应步骤）`;
        target.note = [target.note, raw].filter(Boolean).join('\n');
        notices.push({ severity: 'warning', message: `步骤 ${p.sourceNo ?? index + 1} 引用的“步骤 ${no}”在稿中不存在，已留在旁注里。`, line: p.startLine });
      }
    });
    target.references = refs;
  });

  /* 未知规则：保留原文并提示 */
  pending.forEach((p, index) => {
    if (!p || !p.rule) return;
    const { rule, known } = canonicalRule(p.rule);
    steps[index].rule = rule;
    if (!known) {
      notices.push({ severity: 'info', message: `步骤 ${p.sourceNo ?? index + 1} 的推理规则“${rule}”不在内置规则表中，已按原文保留。`, line: p.startLine });
    }
  });

  /* 空命题步骤 */
  steps.forEach((step, index) => {
    if (!step.statement.trim() && !step.note.includes('无法识别为标准证明步骤')) {
      step.statement = '〔导入〕原稿此处为空，请补填命题。';
      notices.push({ severity: 'warning', message: `第 ${index + 1} 个步骤缺少命题文字，已留占位。` });
    }
  });

  /* 合并重复提示，避免刷屏 */
  const deduped: ImportNotice[] = [];
  notices.forEach((notice) => {
    if (!deduped.some((item) => item.severity === notice.severity && item.message === notice.message)) deduped.push(notice);
  });

  const document: ProofDocument = {
    id: createId('doc'),
    title: body.title || '导入的证明',
    author: '导入稿',
    goal: body.goal,
    symbols: body.symbols,
    steps,
    versions: [],
    updatedAt: new Date().toISOString(),
  };

  return {
    format,
    document,
    notices: deduped,
    recoveredSteps: pending.filter(Boolean).length,
    unparsedChunks: body.items.filter((item) => item.kind === 'loose').length,
  };
}

/* ------------------------------------------------------------------ */
/* 入口                                                                */
/* ------------------------------------------------------------------ */

export function importProof(raw: string): ImportResult | null {
  const input = raw.replace(/^﻿/, '').trim();
  if (!input) return null;
  if (LATEX_MARKER.test(input)) {
    return buildResult(parseLatex(input), 'latex');
  }
  const hasMarkdownStructure = /(^|\n)#{1,6}\s+\S/.test(input) || /\*\*[^*]+\*\*/.test(input);
  return buildResult(parseMarkdown(input), hasMarkdownStructure ? 'markdown' : 'text');
}
