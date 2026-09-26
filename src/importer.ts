import { createId } from './store';
import type { ProofStep, StepType } from './types';

export interface ParsedDraft {
  title: string;
  goal: string;
  symbols: Record<string, string>;
  steps: ProofStep[];
  warnings: string[];
}

interface DraftStep {
  ordinal?: number;
  type?: StepType;
  statement: string;
  rule: string;
  referenceNumbers: number[];
  note: string;
  counterexample: string;
  alternative: string;
  unparsed: string[];
}

const PREMISE_WORDS = ['前提', '已知', '假设', '公理'];
const GOAL_WORDS = ['目标', '结论', '待证', '证明目标', '目标 / 结论'];
const DERIVATION_WORDS = ['推导', '推理', '推论', '演绎', '中间步骤'];
const UNKNOWN_WORDS = ['待辨认', '未知', '无法辨认'];

function cleanInline(text: string): string {
  return text.replace(/\*\*/g, '').replace(/<br\s*\/?>/gi, '\n').replace(/[ \t]+/g, ' ').trim();
}

function cleanMath(text: string): string {
  const value = cleanInline(text);
  return value.replace(/^\$+|\$+$/g, '').trim() || value;
}

function cleanLatexLine(text: string): string {
  return text
    .replace(/\\par(?:\b)?/g, '')
    .replace(/\\small(?:\b)?/g, '')
    .replace(/\\textbf\{([^}]*)\}/g, '$1')
    .replace(/\\section\*?\{([^}]*)\}/g, '$1')
    .replace(/\\{2}\s*$/, '')
    .trim();
}

function makeStep(): DraftStep {
  return {
    statement: '',
    rule: '',
    referenceNumbers: [],
    note: '',
    counterexample: '',
    alternative: '',
    unparsed: [],
  };
}

function toProofStep(step: DraftStep, warnings: string[], index: number): ProofStep {
  const display = step.ordinal ?? index + 1;
  let type = step.type;
  if (!type) {
    if (step.rule === '结论') type = 'goal';
    else if (step.rule === '前提') type = 'premise';
    else type = 'derivation';
  }
  if (!step.statement && type !== 'unknown') type = 'unknown';
  if (type === 'premise' && !step.rule) step.rule = '前提';
  if (type === 'goal' && !step.rule) step.rule = '结论';
  if (type === 'unknown' && !(step.unparsed.length && !step.statement)) warnings.push(`第 ${display} 处内容无法辨认，原文已保留。`);
  if (type === 'derivation' && !step.rule && !step.unparsed.length) warnings.push(`步骤 ${display} 未写明推理规则，已留空待补。`);
  if (step.unparsed.length && type !== 'unknown') warnings.push(`步骤 ${display} 有 ${step.unparsed.length} 行未归入已知字段，已原样保留。`);

  return {
    id: createId('imported'),
    type,
    statement: step.statement,
    rule: step.rule,
    references: [],
    note: step.note,
    counterexample: step.counterexample,
    alternative: step.alternative,
    unparsed: step.unparsed.join('\n'),
  };
}

function parseType(value: string, display: string, warnings: string[]): StepType | undefined {
  const text = cleanInline(value);
  if (PREMISE_WORDS.some((word) => text.includes(word))) return 'premise';
  if (GOAL_WORDS.some((word) => text.includes(word))) return 'goal';
  if (DERIVATION_WORDS.some((word) => text.includes(word))) return 'derivation';
  if (UNKNOWN_WORDS.some((word) => text.includes(word))) return 'unknown';
  if (text) warnings.push(`步骤 ${display} 的类型“${text}”无法识别，已按推导保留。`);
  return 'derivation';
}

function parseReferenceNumbers(value: string): number[] {
  const numbers: number[] = [];
  const pattern = /(\d+)\s*(?:[-–—至到~～]\s*(\d+))?/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value))) {
    const start = Number(match[1]);
    const end = match[2] ? Number(match[2]) : start;
    for (let number = start; number <= end; number += 1) numbers.push(number);
  }
  return [...new Set(numbers)].sort((a, b) => a - b);
}

function parseField(step: DraftStep, label: string, value: string, display: string, warnings: string[]): boolean {
  const text = cleanInline(value);
  if (!text) return true;
  if (label.includes('类型')) {
    step.type = parseType(text, display, warnings);
  } else if (label.includes('推理规则') || label.includes('规则')) {
    step.rule = text;
  } else if (label.includes('依据') || label.includes('引用')) {
    step.referenceNumbers = parseReferenceNumbers(text);
  } else if (label.includes('旁注') || label.includes('备注')) {
    step.note = text;
  } else if (label.includes('反例')) {
    step.counterexample = text;
  } else if (label.includes('替代') || label.includes('分支')) {
    step.alternative = text;
  } else if (label.includes('待辨认') || label.includes('原文')) {
    step.unparsed.push(text);
  } else {
    return false;
  }
  return true;
}

function parseSymbolLine(line: string, symbols: Record<string, string>): boolean {
  const value = line.replace(/^[-*+]\s*/, '').trim();
  const match = value.match(/^(?:\$?)([^:：$]+?)(?:\$?)\s*[:：]\s*(.+)$/);
  if (!match) return false;
  const symbol = cleanMath(match[1]);
  const meaning = cleanInline(match[2]);
  if (symbol && meaning) symbols[symbol] = meaning;
  return true;
}

function isSymbolHeading(line: string): boolean {
  return /^#{1,6}\s*符号表\s*$/.test(line.trim()) || /\\(?:section|subsection|paragraph)\*?\{[^}]*符号表[^}]*\}/.test(line);
}

function parseMarkdown(content: string): ParsedDraft {
  const result: ParsedDraft = { title: '', goal: '', symbols: {}, steps: [], warnings: [] };
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  const symbolStart = lines.findIndex((line) => isSymbolHeading(line.trim()));
  const bodyLines = symbolStart >= 0 ? lines.slice(0, symbolStart) : lines;
  const drafts: DraftStep[] = [];
  const numbered: DraftStep[] = [];
  const looseOrdinals: number[] = [];
  const extraLines: string[] = [];
  let current = makeStep();
  let currentOrdinal: number | undefined;
  let seenStepHeading = false;
  let pendingExplicit = false;
  let lastNumbered: DraftStep | null = null;

  const finishCurrent = () => {
    if (pendingExplicit) {
      drafts.push(current);
      pendingExplicit = false;
    } else if (lastNumbered && current.unparsed.length) {
      lastNumbered.unparsed.push(...current.unparsed);
    }
    lastNumbered = null;
    current = makeStep();
    currentOrdinal = undefined;
  };

  bodyLines.forEach((rawLine) => {
    const line = rawLine.trim();
    if (!line) return;

    const titleMatch = line.match(/^#\s+(.+)$/);
    if (titleMatch && !result.title) {
      result.title = cleanInline(titleMatch[1]);
      return;
    }

    const goalMatch = line.match(/(?:\*\*)?证明目标\s*[：:](?:\*\*)?\s*(.+)$/);
    if (goalMatch) {
      finishCurrent();
      result.goal = cleanMath(goalMatch[1]);
      return;
    }

    const stepHeading = line.match(/^##\s*(?:步骤\s*)?(\d+)\s*[.、．]?\s*(.*)$/);
    if (stepHeading) {
      finishCurrent();
      currentOrdinal = Number(stepHeading[1]);
      current.ordinal = currentOrdinal;
      current.statement = cleanInline(stepHeading[2]);
      pendingExplicit = true;
      seenStepHeading = true;
      return;
    }

    if (/^#{1,6}\s+/.test(line)) {
      finishCurrent();
      return;
    }

    const fieldMatch = line.match(/^[-*+]\s*([^:：]+)\s*[：:]\s*(.*)$/);
    if (fieldMatch && (pendingExplicit || lastNumbered)) {
      const target = pendingExplicit ? current : lastNumbered!;
      const display = String(currentOrdinal ?? drafts.length + numbered.length + 1);
      if (!parseField(target, cleanInline(fieldMatch[1]), fieldMatch[2], display, result.warnings)) {
        target.unparsed.push(line);
      }
      return;
    }

    const looseStep = line.match(/^(\d+)\s*[.、．]\s*(.+)$/);
    if (!seenStepHeading && looseStep) {
      pendingExplicit = false;
      current = makeStep();
      currentOrdinal = Number(looseStep[1]);
      current.ordinal = currentOrdinal;
      current.statement = cleanInline(looseStep[2]);
      current.type = 'derivation';
      looseOrdinals.push(currentOrdinal);
      numbered.push(current);
      lastNumbered = current;
      return;
    }

    if (pendingExplicit) {
      current.statement = current.statement ? `${current.statement}\n${cleanInline(line)}` : cleanInline(line);
    } else if (lastNumbered) {
      current.unparsed.push(cleanInline(line));
    } else {
      extraLines.push(line);
    }
  });
  finishCurrent();
  if (symbolStart >= 0) {
    for (const rawLine of lines.slice(symbolStart + 1)) {
      const line = rawLine.trim();
      if (!line) continue;
      if (/^#{1,6}\s+/.test(line)) break;
      if (!parseSymbolLine(line, result.symbols)) extraLines.push(line);
    }
  }

  const ordered = seenStepHeading ? drafts : numbered;
  if (extraLines.length) {
    const extra = makeStep();
    extra.type = 'unknown';
    extra.statement = '';
    extra.unparsed = extraLines.map((line) => cleanInline(line));
    ordered.push(extra);
    result.warnings.push('有原文未归入标题、目标、步骤或符号表，已保留为待辨认内容。');
  }
  if (!seenStepHeading && looseOrdinals.some((ordinal, index) => ordinal !== index + 1)) {
    result.warnings.push('稿件的步骤编号不连续，引用将按原编号对应。');
  }
  if (!ordered.length && content.trim()) {
    result.warnings.push('未识别到标准步骤，整篇原文已保留为待辨认内容。');
  }
  result.steps = linkSteps(ordered, result.warnings);
  return finalizeDraft(result);
}

function splitLatexSupport(value: string): { rule: string; numbers: number[] } {
  const text = cleanLatexLine(value).replace(/^依据\s*/, '');
  const parts = text.split(/[；;，,、]/).map((part) => part.trim()).filter(Boolean);
  let rule = '';
  let numbers: number[] = [];
  parts.forEach((part) => {
    const referenceMatch = part.match(/^(?:步骤\s*)?((?:\d+\s*(?:[-–—至到~～]\s*\d+)?\s*[,，、和]?\s*)+)$/);
    if (/\d/.test(part) && (part.includes('步骤') || referenceMatch)) {
      numbers.push(...parseReferenceNumbers(part.replace(/步骤/g, '')));
    } else if (!rule) {
      rule = part;
    }
  });
  return { rule, numbers: [...new Set(numbers)].sort((a, b) => a - b) };
}

function parseLatex(content: string): ParsedDraft {
  const result: ParsedDraft = { title: '', goal: '', symbols: {}, steps: [], warnings: [] };
  const drafts: DraftStep[] = [];
  const extraLines: string[] = [];
  let current = makeStep();
  let hasCurrent = false;
  let inSymbols = false;

  const finish = () => {
    if (hasCurrent) drafts.push(current);
    current = makeStep();
    hasCurrent = false;
  };

  const titleMatch = content.match(/\\section\*\{([^}]+)\}/);
  if (titleMatch) result.title = cleanLatexLine(titleMatch[1]);

  const goalMatch = content.match(/\\textbf\{证明目标[：:]\}\s*(.+)|证明目标[：:]\s*(.+)/);
  if (goalMatch) result.goal = cleanMath(cleanLatexLine(goalMatch[1] ?? goalMatch[2] ?? ''));

  content.replace(/\r\n?/g, '\n').split('\n').forEach((rawLine) => {
    const line = rawLine.trim();
    if (!line || /^\\(?:documentclass|usepackage|begin\{document\}|end\{document\}|begin\{enumerate\}|end\{enumerate\})/.test(line)) return;

    if (isSymbolHeading(line)) {
      finish();
      inSymbols = true;
      return;
    }
    if (inSymbols) {
      if (/\\(?:section|subsection)/.test(line)) {
        inSymbols = false;
      } else if (parseSymbolLine(cleanLatexLine(line), result.symbols)) {
        return;
      } else {
        extraLines.push(cleanLatexLine(line));
        return;
      }
    }

    const structured = line.match(/^%+\s*([^:：]+)\s*[：:]\s*(.*)$/);
    if (structured && hasCurrent) {
      if (!parseField(current, cleanInline(structured[1]), structured[2], String(drafts.length + 1), result.warnings)) {
        current.unparsed.push(cleanLatexLine(line));
      }
      return;
    }

    const itemMatch = line.match(/^\\item\s+(.+)$/);
    if (itemMatch) {
      finish();
      hasCurrent = true;
      let text = itemMatch[1].trim();
      const supportMatch = text.match(/[（(]([^（）()]+)[）)]\s*$/);
      if (supportMatch) {
        const support = splitLatexSupport(supportMatch[1]);
        current.rule = support.rule;
        current.referenceNumbers = support.numbers;
        text = text.slice(0, supportMatch.index).trim();
      }
      current.statement = cleanInline(cleanLatexLine(text));
      if (!current.type) current.type = 'derivation';
      return;
    }

    const annotation = cleanLatexLine(line).match(/^(旁注|反例|替代分支)\s*[：:]\s*(.+)$/);
    if (annotation && hasCurrent) {
      const text = cleanInline(annotation[2]);
      if (annotation[1] === '旁注') current.note = text;
      else if (annotation[1] === '反例') current.counterexample = text;
      else current.alternative = text;
      return;
    }

    if (hasCurrent && !/^%/.test(line)) current.unparsed.push(cleanLatexLine(line));
    else if (!hasCurrent && !/^\\(?:section\*?|textbf)/.test(line) && !/证明目标/.test(line)) extraLines.push(cleanLatexLine(line));
  });
  finish();
  if (extraLines.length) {
    const extra = makeStep();
    extra.type = 'unknown';
    extra.unparsed = extraLines.filter(Boolean);
    drafts.push(extra);
    result.warnings.push('LaTeX 中有未归入步骤的原文，已保留为待辨认内容。');
  }

  result.steps = linkSteps(drafts, result.warnings);
  if (!result.steps.length && content.trim()) result.warnings.push('未从 LaTeX 中识别到 \\item 步骤，原文无法可靠恢复。');
  return finalizeDraft(result);
}

function linkSteps(drafts: DraftStep[], warnings: string[]): ProofStep[] {
  const initialSteps = drafts.map((draft, index) => toProofStep(draft, warnings, index));
  const ordinals = drafts.map((draft, index) => draft.ordinal ?? index + 1);
  const firstByOrdinal = new Map<number, number>();
  ordinals.forEach((ordinal, index) => {
    if (!firstByOrdinal.has(ordinal)) firstByOrdinal.set(ordinal, index);
  });

  const referenced = new Set<number>();
  drafts.forEach((draft) => draft.referenceNumbers.forEach((number) => referenced.add(number)));
  const missingNumbers = [...referenced].filter((number) => !firstByOrdinal.has(number)).sort((a, b) => a - b);
  const placeholdersByOrdinal = new Map<number, ProofStep>();
  missingNumbers.forEach((number) => {
    placeholdersByOrdinal.set(number, {
      id: createId('imported'),
      type: 'unknown',
      statement: `【原稿引用了步骤 ${number}，但导出稿中缺少这一步；此处为占位，待补回原文】`,
      rule: '',
      references: [],
      note: '',
      counterexample: '',
      alternative: '',
      unparsed: '',
    });
    warnings.push(`原稿引用的步骤 ${number} 不存在，已插入占位而不是丢弃引用。`);
  });

  type PositionedStep = { ordinal: number; step: ProofStep; isPlaceholder: boolean };
  const positioned: PositionedStep[] = [
    ...initialSteps.map((step, index) => ({ ordinal: ordinals[index], step, isPlaceholder: false })),
    ...[...placeholdersByOrdinal.entries()].map(([ordinal, step]) => ({ ordinal, step, isPlaceholder: true })),
  ].sort((a, b) => a.ordinal - b.ordinal || Number(a.isPlaceholder) - Number(b.isPlaceholder));

  const steps = positioned.map((item) => item.step);
  const stepIndex = new Map<ProofStep, number>();
  steps.forEach((step, index) => stepIndex.set(step, index));

  drafts.forEach((draft, draftIndex) => {
    const index = stepIndex.get(initialSteps[draftIndex]);
    if (index === undefined) return;
    steps[index].references = draft.referenceNumbers.map((number) => {
      const originalDraftIndex = firstByOrdinal.get(number);
      if (originalDraftIndex !== undefined) return initialSteps[originalDraftIndex].id;
      return placeholdersByOrdinal.get(number)?.id ?? createId('missing');
    });
  });

  return steps;
}

function finalizeDraft(draft: ParsedDraft): ParsedDraft {
  draft.warnings = [...new Set(draft.warnings)];
  if (!draft.title) {
    draft.title = '导入的证明稿';
    draft.warnings.push('未找到标题，已使用临时标题。');
  }
  if (!draft.goal) {
    draft.goal = '$待从原稿辨认$';
    draft.warnings.push('未找到证明目标，已保留待补内容。');
  }
  if (!draft.steps.some((step) => step.type === 'goal')) {
    draft.warnings.push('未识别到最终结论步骤。');
  }
  return draft;
}

export function parseProofDraft(content: string): ParsedDraft {
  const text = content.trim();
  if (!text) return { title: '导入的证明稿', goal: '$待从原稿辨认$', symbols: {}, steps: [], warnings: ['稿件为空，没有可导入的内容。'] };
  if (/\\documentclass|\\begin\{enumerate\}|\\section\*/.test(text)) return parseLatex(text);
  return parseMarkdown(text);
}
