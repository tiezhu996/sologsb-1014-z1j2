import { importProof } from '../src/import.ts';

let passed = 0;
let failed = 0;

function check(name, cond, detail = '') {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? `\n    ${detail}` : ''}`);
  }
}

/* 1. 标准导出稿往返：依据序号必须重映射到真实步骤 id */
const roundtrip = `# 完全平方公式证明

**证明目标：** $(a+b)^2=a^2+2ab+b^2$

## 1. $a,b$ 是实数

- 类型：前提
- 推理规则：前提

## 2. $(a+b)^2=(a+b)(a+b)$

- 类型：推导
- 推理规则：定义展开
- 依据：步骤 1
- 旁注：把平方写成两个相同因式之积。

## 3. $(a+b)(a+b)=a^2+ab+ba+b^2$

- 类型：推导
- 推理规则：分配律
- 依据：步骤 2
- 替代分支：也可先展开后半部分。

## 4. $a^2+ab+ba+b^2=a^2+2ab+b^2$

- 类型：推导
- 推理规则：同类项合并
- 依据：步骤 3
- 反例：在特征 2 下 $2ab=0$，结论形式不同。

## 5. $(a+b)^2=a^2+2ab+b^2$

- 类型：目标 / 结论
- 推理规则：结论
- 依据：步骤 4

## 符号表

- $a$：实数
- $b$：实数
`;

const r1 = importProof(roundtrip);
check('识别为 markdown', r1.format === 'markdown', r1.format);
check('恢复标题', r1.document.title === '完全平方公式证明', r1.document.title);
check('恢复目标', r1.document.goal === '$(a+b)^2=a^2+2ab+b^2$', r1.document.goal);
check('恢复 5 个步骤', r1.document.steps.length === 5, String(r1.document.steps.length));
check('步骤 1 是前提', r1.document.steps[0].type === 'premise');
check('步骤 5 是目标', r1.document.steps[4].type === 'goal');
check('步骤 2 依据重映射到步骤 1', r1.document.steps[1].references[0] === r1.document.steps[0].id);
check('步骤 5 依据重映射到步骤 4', r1.document.steps[4].references[0] === r1.document.steps[3].id);
check('步骤 2 旁注恢复', r1.document.steps[1].note === '把平方写成两个相同因式之积。');
check('步骤 3 替代分支恢复', r1.document.steps[2].alternative === '也可先展开后半部分。');
check('步骤 4 反例恢复', r1.document.steps[3].counterexample.includes('特征 2'));
check('符号表恢复', r1.document.symbols.a === '实数' && r1.document.symbols.b === '实数');
check('标准稿无警告', r1.notices.every((n) => n.severity === 'info'), JSON.stringify(r1.notices));

/* 2. 别人改乱的稿子：插步骤导致编号变化、引用缺失、未知规则、读不懂的段落 */
const messy = `# 群里改回的稿子

证明目标：$x^2-y^2=(x-y)(x+y)$

老师在群里说这一步要再想想，原文我也没太看懂，先留着：
？？？这里好像要用几何解释@@@

1. $x,y$ 为实数
- 类型：前提
- 推理规则：前提

步骤2：$x^2-y^2=x^2+xy-xy-y^2$
- 类型：推导
- 规则：神奇恒等变形
- 依据：步骤 1、步骤 9（待补的一步）
- 旁注：中间项一加一减。

3) 这一步是后来补的：$x^2+xy-xy-y^2=x(x+y)-y(x+y)$
- 类别: 推导
- 引用: 2

4. $x(x+y)-y(x+y)=(x-y)(x+y)$
- 推理规则：分配律
- 依据：第 3 步
`;

const r2 = importProof(messy);
check('乱稿恢复 5 个块（1 段原样保留 + 4 步）', r2.document.steps.length === 5, String(r2.document.steps.length));
const loose = r2.document.steps.find((s) => s.note.includes('无法识别'));
check('读不懂的段落原样保留', loose && loose.statement.includes('几何解释'), loose?.statement);
const s2 = r2.document.steps.find((s) => s.statement.includes('$x^2-y^2=x^2'));
check('缺失引用（步骤 9）不丢内容，转入旁注', s2 && s2.note.includes('步骤 9') && s2.references.length === 1, JSON.stringify(s2));
check('有效引用仍重映射（依据步骤 1）', s2 && s2.references[0] === r2.document.steps.find((s) => s.statement.includes('$x,y$'))?.id);
check('未知规则原文保留', s2 && s2.rule === '神奇恒等变形', s2?.rule);
check('未知规则给出 info 提示', r2.notices.some((n) => n.severity === 'info' && n.message.includes('神奇恒等变形')));
const inserted = r2.document.steps.find((s) => s.statement.includes('后来补的'));
check('插入步骤后，“依据第 3 步”对到真实第 3 个步骤（新插入的那步）', inserted && r2.document.steps[4].references[0] === inserted.id);
check('“类别”同义词识别为类型字段', inserted && inserted.type === 'derivation');
check('无标题丢失整篇', r2.document.title === '群里改回的稿子');

/* 3. 纯文本编号稿：无 # 标题、无项目符号字段 */
const plain = `平方差练习
1. $n$ 是正整数。类型：前提
2. $P(1)$ 成立
推理规则：前提
依据：1
3. $P(n)$ 成立。类型：结论，规则：结论
依据：2、1
`;

const r3 = importProof(plain);
check('纯文本按 text 识别', r3.format === 'text', r3.format);
check('无 # 时首行当标题', r3.document.title === '平方差练习', r3.document.title);
check('纯文本识别 3 步', r3.document.steps.length === 3, String(r3.document.steps.length));
check('字段续行也能解析（依据 1）', r3.document.steps[1].references[0] === r3.document.steps[0].id);
check('多引用全部重映射', r3.document.steps[2].references.length === 2);
check('缺目标给警告而非报错', r3.notices.some((n) => n.message.includes('证明目标')));

/* 4. 范围引用 3-5 */
const ranges = `# 范围引用稿
证明目标：$A$
1. a
2. b
3. c
4. d
5. e
6. f
- 依据：步骤 1-3、步骤 5
`;
const r4 = importProof(ranges);
check('范围引用 1-3 + 5 展开为 4 个引用', r4.document.steps[5].references.length === 4, String(r4.document.steps[5].references.length));

/* 5. LaTeX 往返 */
const latex = `\\documentclass{article}
\\usepackage{amsmath,amssymb}
\\begin{document}
\\section*{平方差}
\\textbf{证明目标：} $x^2-y^2=(x-y)(x+y)$
\\begin{enumerate}
  \\item $x,y$ 为实数 （前提）
  \\item $x^2-y^2=x(x+y)-y(x+y)$ （依据 1；代入）
  \\par\\small 旁注：补零项。
  \\item $x(x+y)-y(x+y)=(x-y)(x+y)$ （依据 2；分配律）
\\end{enumerate}
\\end{document}
`;
const r5 = importProof(latex);
check('识别为 latex', r5.format === 'latex');
check('LaTeX 标题恢复', r5.document.title === '平方差');
check('LaTeX 目标恢复', r5.document.goal.includes('x^2-y^2'));
check('LaTeX 恢复 3 步', r5.document.steps.length === 3, String(r5.document.steps.length));
check('LaTeX 引用重映射', r5.document.steps[1].references[0] === r5.document.steps[0].id);
check('LaTeX 旁注恢复', r5.document.steps[1].note.includes('补零项'));
check('LaTeX 规则恢复', r5.document.steps[2].rule === '分配律');
check('LaTeX 提示旁注字段局限', r5.notices.some((n) => n.message.includes('反例')));

/* 6. 整篇都读不懂也不能丢 */
const garbage = `这就是一段随手写的笔记
没有任何结构
老师讲的思路大概是先加一项再减一项`;
const r6 = importProof(garbage);
check('无结构稿不返回空', r6.document.steps.length === 1, String(r6.document.steps.length));
check('无结构稿全文原样保留', r6.document.steps[0].statement.includes('先加一项再减一项'));

/* 7. 空输入 */
check('空输入返回 null', importProof('   \n  ') === null);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
