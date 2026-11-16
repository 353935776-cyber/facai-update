'use strict';
/**
 * 本地提示词构建器：替代原版内核（V8 字节码，不可抄）的 novel.buildPrompt 服务。
 *
 * 契约（实测 dist，novel-DyP-L59w.js）：
 *   coreBridge.invoke('novel.buildPrompt', { kind, payload })
 *     -> { ok:true, data:{ success:true, data:{ prompt } } }
 *
 * kind 共 14 种，payload 形状各不相同；输出必须能被前端解析器吃下：
 *   worldview      {project}                                  -> JSON{世界基本法则,主要势力[],关键地点[],时间线}
 *   character      {project, worldview}                        -> JSON{主角设定{},关键配角设定[]}
 *   outline        {project, worldview, characters}             -> JSON{章节大纲[]}
 *   foreshadowing  {outlineSummary, project}                   -> JSON{核心伏笔[],短期伏笔[],人物伏笔[],世界观伏笔[]}
 *   creativeCard   {project, blueprint, ...}                   -> JSON 任意结构（前端扁平化为文本）
 *   continueState  {project, ...}                              -> JSON 状态交接
 *   quality        {project, reviewContext, ...}               -> JSON{mode,passed,score,findings[],nextActions[]}
 *   seasonBridge   {context, project}                          -> JSON{endingSummary,unresolvedThreads[],characterStates[]}
 *   singleChapter  {chapterNumber,detailedOutlineJson,...}     -> 系统提示词（正文创作规范，非 JSON）
 *   batchChapter   {chapterNumber,level5Outline,...}           -> 用户提示词（正文，可含【字数统计：N字】）
 *   expand         {content,targetWords,currentWords,...}      -> 扩写提示词
 *   textOperation  {operation,text,customInstructions}         -> 文本操作提示词
 *   aiTasteOptimize{text,detectionSummary,customInstructions}  -> JSON{optimizedContent,optimizationPoints[],afterOptimizationAiRatio,summary}
 */

const N = (v, d) => (v == null || v === '' ? d : v);
const S = (v, d = '') => String(N(v, d)).trim();
const J = (v) => { try { return JSON.stringify(v); } catch { return String(v); } };

function projectBlock(p) {
  const o = p && typeof p === 'object' ? p : {};
  const lines = [
    `作品名称：${S(o.name, '未命名作品')}`,
    `小说类型：${S(o.genre, '未指定')}`,
    `主角姓名：${S(o.protagonist, '未指定')}`,
    `主角性格：${S(o.protagonistPersonality, '未指定')}`,
    `故事背景：${S(o.background, '未指定')}`,
    `核心冲突：${S(o.coreConflict, '未指定')}`,
  ];
  if (o.stylePreference) lines.push(`风格偏好：${S(o.stylePreference)}`);
  if (o.narrativeMode) lines.push(`叙述方式：${o.narrativeMode === 'firstPerson' ? '第一人称' : '第三人称'}`);
  if (o.isSystemNovel === true) lines.push('是否系统文：是（需要金手指/系统面板设定）');
  if (o.targetWordCount) lines.push(`目标字数：${o.targetWordCount} 字`);
  if (o.chapterEstimatedWordCount) lines.push(`单章预计字数：${o.chapterEstimatedWordCount} 字`);
  if (o.totalChapters) lines.push(`预计章节数：${o.totalChapters} 章`);
  if (o.customInstructions) lines.push(`作者补充要求：${S(o.customInstructions)}`);
  return lines.join('\n');
}

function blueprintSummary(bp) {
  if (!bp || typeof bp !== 'object') return '';
  const parts = [];
  if (bp.worldviewText) parts.push(`【世界观】\n${S(bp.worldviewText).slice(0, 1800)}`);
  if (bp.charactersText) parts.push(`【人物】\n${S(bp.charactersText).slice(0, 1800)}`);
  if (bp.outlineText) parts.push(`【大纲】\n${S(bp.outlineText).slice(0, 1800)}`);
  if (Array.isArray(bp.foreshadowings) && bp.foreshadowings.length) {
    parts.push(`【伏笔】\n${bp.foreshadowings.slice(0, 20).map((f) => S(f && f.content)).filter(Boolean).join('\n')}`);
  }
  return parts.join('\n\n');
}

function jsonOnly(extra) {
  return [
    '输出要求：',
    '- 只输出一个合法 JSON 对象，不要 Markdown 代码块、不要任何解释文字。',
    '- 所有字段名使用简体中文，字符串使用双引号。',
    extra || '',
  ].filter(Boolean).join('\n');
}

const B = {
  // 「💡 AI总结小说信息」：一句话想法 → 5 套可选作品方案（前端要求返回 JSON 数组，5 项）
  novelIdea(payload = {}) {
    const idea = S(payload.userIdea);
    return [
      '你是网文选题策划。请把作者的一句话想法，扩展成 5 套可直接开写的小说方案。',
      '',
      '【作者的想法】',
      idea || '（作者没有给出具体想法，请自行设计 5 个有爆款潜力的原创选题）',
      '',
      '【要求】',
      '1. 5 套方案必须在题材、主角设定、冲突类型上明显区分，不要同质化；',
      '2. 每套方案都要能支撑 50 万字以上长篇连载；',
      '3. genre 用简短题材词（如 都市异能 / 东方玄幻 / 科幻悬疑）；',
      '4. targetWordCount 取 300000-1500000 之间的整数；',
      '5. chapterEstimatedWordCount 取 2000-3500 之间的整数；',
      '6. reason 用一句话说明这套方案的卖点。',
      '',
      '【输出格式】只输出一个 JSON 数组，不要 Markdown、不要解释：',
      JSON.stringify([{
        name: '作品名',
        protagonist: '主角名',
        protagonistPersonality: '主角性格，逗号分隔 3 个关键词',
        genre: '题材',
        background: '故事背景，60 字以内',
        coreConflict: '核心冲突，60 字以内',
        targetWordCount: 500000,
        stylePreference: '风格偏好',
        isSystemNovel: false,
        chapterEstimatedWordCount: 2500,
        reason: '一句话卖点',
      }], null, 2),
    ].join('\n');
  },

  worldview(payload = {}) {
    const p = payload.project || {};
    return [
      '你是资深长篇小说世界观架构师。请基于以下作品契约，设计一套可直接支撑长篇连载的世界观。',
      '',
      '【作品契约】',
      projectBlock(p),
      '',
      '【设计目标】',
      '1. 世界规则必须能持续制造冲突，而不是背景板；',
      '2. 势力之间要有结构性利益冲突，各自目标明确；',
      '3. 关键地点要能反复使用，承载不同阶段剧情；',
      '4. 时间线要交代故事起点之前的重大历史事件。',
      '',
      '【输出结构】',
      JSON.stringify({
        世界基本法则: '300-500字，说明世界运行的根本规则与代价',
        主要势力: [{ 势力名称: '', 定位: '', 设定: '', 核心诉求: '', 与主角关系: '' }],
        关键地点: [{ 地点名称: '', 描述: '地理特征与战略价值' }],
        力量体系: '等级/来源/限制与代价',
        时间线: '按时间顺序列出 5-8 个历史节点',
        补充设定: '其他需要说明的设定',
      }, null, 2),
      '',
      jsonOnly('主要势力至少 4 个，关键地点至少 5 个。'),
    ].join('\n');
  },

  character(payload = {}) {
    const p = payload.project || {};
    return [
      '你是人物塑造专家。请基于作品契约与世界观，设计主角与关键配角。',
      '',
      '【作品契约】',
      projectBlock(p),
      '',
      '【世界观】',
      S(payload.worldview).slice(0, 3000) || '（暂无，请依据作品契约自行推演）',
      '',
      '【输出结构】',
      JSON.stringify({
        主角设定: {
          角色姓名: '', 核心性格: '', 社会身份: '', 所属势力: '',
          核心目标: '', 心智缺陷: '致命短板或恐惧', 能力与代价: '',
          人物弧光: '从什么状态走向什么状态', 与主线的关系: '',
        },
        关键配角设定: [{
          角色姓名: '', 核心性格: '', 社会身份: '', 所属势力: '',
          与主角关系: '', 核心目标: '', 人物高光时刻: '',
        }],
      }, null, 2),
      '',
      jsonOnly('关键配角至少 4 位，每人目标必须与主角目标发生摩擦。'),
    ].join('\n');
  },

  outline(payload = {}) {
    const p = payload.project || {};
    const total = Number(p.totalChapters) || 60;
    return [
      '你是长篇连载结构师。请基于作品契约、世界观与人物，给出第一季总纲与章节大纲。',
      '',
      '【作品契约】',
      projectBlock(p),
      '',
      '【世界观】',
      S(payload.worldview).slice(0, 2200),
      '',
      '【人物】',
      S(payload.characters).slice(0, 2200),
      '',
      '【输出结构】',
      JSON.stringify({
        第一季总纲: '本季主线目标、三幕结构与高潮位置',
        章节大纲: [{ 章节号: 1, 标题: '', 剧情概要: '100字以内', 核心事件: '', 涉及人物: [] }],
      }, null, 2),
      '',
      jsonOnly(`章节大纲请覆盖 1-${Math.min(total, 60)} 章，每章都要推动主线或埋设伏笔。`),
    ].join('\n');
  },

  foreshadowing(payload = {}) {
    const p = payload.project || {};
    return [
      '你是伏笔管理专家。请基于已完成的章节大纲，规划可追踪的伏笔体系。',
      '',
      '【章节大纲】',
      S(payload.outlineSummary).slice(0, 4000),
      '',
      '【作品契约】',
      projectBlock(p),
      '',
      '【输出结构】',
      JSON.stringify({
        核心伏笔: [{ name: '', 内容: '', setup_chapter: 1, payoff_chapter: 20, 回收方式: '' }],
        短期伏笔: [{ name: '', 内容: '', setup_chapter: 1, payoff_chapter: 5 }],
        人物伏笔: [{ name: '', 内容: '', setup_chapter: 1, payoff_chapter: 15 }],
        世界观伏笔: [{ name: '', 内容: '', setup_chapter: 1, payoff_chapter: 30 }],
      }, null, 2),
      '',
      jsonOnly('setup_chapter / payoff_chapter 必须是数字，且 payoff 大于 setup。每一类至少 2 条。'),
    ].join('\n');
  },

  creativeCard(payload = {}) {
    const p = payload.project || {};
    return [
      '你是爆款小说策划。请为这部作品写一张核心创意卡，把「一句话能说清」的卖点钉死。',
      '',
      '【作品契约】',
      projectBlock(p),
      '',
      '【输出结构】',
      JSON.stringify({
        一句话主线: '',
        读者承诺: '读者点进来能得到什么爽感',
        差异化: '与同类作品的最大不同',
        四大驱动: { 目标驱动: '', 阻力驱动: '', 关系驱动: '', 成长驱动: '' },
        开篇钩子: '前三章抓人的具体设计',
        长线悬念: '',
      }, null, 2),
      '',
      jsonOnly('语言要具体、可执行，不要空话套话。'),
    ].join('\n');
  },

  continueState(payload = {}) {
    const p = payload.project || {};
    const bp = blueprintSummary(payload.blueprint);
    return [
      '你是长篇小说连续性编辑。请把截至目前的所有资产压缩成一份「状态交接单」，供后续章节稳定续写。',
      '',
      '【作品契约】',
      projectBlock(p),
      '',
      bp ? `【已有资产】\n${bp}` : '',
      payload.storyState ? `【当前故事状态】\n${S(payload.storyState).slice(0, 2000)}` : '',
      '',
      '【输出结构】',
      JSON.stringify({
        当前时间地点: '',
        主角当前状态: { 处境: '', 能力: '', 心理: '', 手上资源: '' },
        人物关系现状: [{ 人物: '', 与主角关系: '', 当前立场: '' }],
        未回收伏笔: [''],
        已解决的冲突: [''],
        下一步压力: '推动下一章的具体压力源',
      }, null, 2),
      '',
      jsonOnly('只陈述已发生的事实，不要虚构未写到的剧情。'),
    ].join('\n');
  },

  quality(payload = {}) {
    return [
      '你是长篇小说审校编辑，只做审校，不改写原始资产。',
      '请检查以下创作资产是否存在设定冲突、逻辑断裂、人物动机缺失、伏笔失管等问题。',
      '',
      '【待审校资产】',
      S(payload.reviewContext || JSON.stringify(payload, null, 2)).slice(0, 9000),
      '',
      '【输出结构】',
      JSON.stringify({
        mode: 'QC_FULL',
        passed: true,
        score: { 设定一致性: 0, 逻辑严谨: 0, 人物动机: 0, 伏笔管理: 0 },
        findings: [{ severity: 'blocker|high|medium|low', location: '', problem: '', impact: '', fix: '' }],
        nextActions: [''],
      }, null, 2),
      '',
      jsonOnly('score 各项为 0-100 的整数；无问题时 findings 输出空数组、passed 为 true。'),
    ].join('\n');
  },

  seasonBridge(payload = {}) {
    const p = payload.project || {};
    return [
      '你是系列剧作统筹。上一季已经完结，请整理季终承接，供下一季开篇使用。',
      '',
      '【作品】',
      projectBlock(p),
      '',
      '【上一季结尾信息】',
      S(JSON.stringify(payload.context || {}, null, 2)).slice(0, 6000),
      '',
      '【输出结构】',
      JSON.stringify({
        endingSummary: '上一季结局摘要，300字以内',
        unresolvedThreads: ['尚未回收的悬念'],
        characterStates: [{ name: '', state: '', location: '' }],
        下一季开篇建议: '',
      }, null, 2),
      '',
      jsonOnly(),
    ].join('\n');
  },

  singleChapter(payload = {}) {
    const p = payload.project || {};
    const budget = Number(payload.wordBudget) || Number(p.chapterEstimatedWordCount) || 2500;
    return [
      '你是一位擅长长篇小说连载的中文作者。你的任务是写出可直接发布的章节正文。',
      '',
      '【硬性要求】',
      `1. 正文字数控制在 ${Math.round(budget * 0.9)}-${Math.round(budget * 1.1)} 字之间；`,
      '2. 只输出正文本身，不要标题、不要大纲、不要任何解释或前后缀；',
      '3. 严格遵守已给出的世界观、人物设定与既定剧情，不得自行改写设定；',
      '4. 承接上一章结尾的情绪与处境，不要重复上一章已经写过的情节；',
      `5. 叙述方式：${p.narrativeMode === 'firstPerson' ? '第一人称' : '第三人称'}；`,
      p.stylePreference ? `6. 风格：${S(p.stylePreference)}；` : '',
      '7. 对话要有信息量，避免大段说明性旁白；场景描写服务于情绪与节奏。',
      '',
      '【作品信息】',
      projectBlock(p),
    ].filter(Boolean).join('\n');
  },

  batchChapter(payload = {}) {
    const p = payload.project || {};
    const budget = Number(payload.wordBudget) || 2500;
    const prev = S(payload.previousChapters).slice(-1800);
    return [
      `请写第 ${N(payload.chapterNumber, 1)} 章正文。`,
      '',
      '【本章细纲】',
      S(JSON.stringify(payload.level5Outline || {}, null, 2)).slice(0, 3500),
      '',
      prev ? `【前文结尾（仅用于状态衔接）】\n${prev}` : '',
      '',
      `【字数要求】正文 ${Math.round(budget * 0.9)}-${Math.round(budget * 1.1)} 字，结尾另起一行写「【字数统计：N字】」。`,
      payload.retryAttempt ? `【重写提示】上一次字数不达标（约 ${N(payload.previousAttemptWordCount, 0)} 字），本次请补足场景细节与人物反应，不要注水。` : '',
      '只输出正文。',
    ].filter(Boolean).join('\n');
  },

  expand(payload = {}) {
    const target = Number(payload.targetWords) || 2500;
    return [
      `请把下面的章节正文扩写到约 ${target} 字（当前约 ${N(payload.currentWords, 0)} 字）。`,
      '',
      '【要求】',
      '1. 只补细节、动作、对话、心理与环境，不得新增主线事件或改变结局；',
      '2. 保持原有段落顺序与人物语气；',
      '3. 只输出扩写后的完整正文，不要说明。',
      payload.customInstructions ? `4. 额外要求：${S(payload.customInstructions)}` : '',
      '',
      '【原文】',
      S(payload.content).slice(0, 12000),
    ].filter(Boolean).join('\n');
  },

  textOperation(payload = {}) {
    const op = S(payload.operation, 'polish');
    const guide = {
      polish: '润色以下文本：修掉语病与重复，提升画面感与节奏，不改变情节。',
      rewrite: '改写以下文本：保持信息量，换一种更有张力的表达。',
      expand: '扩写以下文本：补充细节与情绪，保持原意。',
      shorten: '精简以下文本：砍掉冗余，保留关键信息与情绪落点。',
      continue: '续写以下文本：顺着语气与情境自然往下写。',
      summary: '总结以下文本：提炼关键事件、人物状态与未解悬念。',
      title: '为以下文本拟 10 个有吸引力的标题。',
      outline: '为以下文本整理结构化大纲。',
    }[op] || '按作者要求处理以下文本。';
    return [
      guide,
      payload.customInstructions ? `额外要求：${S(payload.customInstructions)}` : '',
      '只输出处理后的结果，不要解释。',
      '',
      '【文本】',
      S(payload.text).slice(0, 12000),
    ].filter(Boolean).join('\n');
  },

  aiTasteOptimize(payload = {}) {
    return [
      '你是文本编辑。请在保留原意与情节的前提下，降低以下文本的「AI 味」，让它更像人类作者的笔触。',
      '手法包括：打散过于工整的排比、减少解释性旁白、加入具体感官细节、允许句式长短不一。',
      '',
      '【原文】',
      S(payload.text).slice(0, 12000),
      payload.detectionSummary ? `\n【AI 检测摘要】\n${S(payload.detectionSummary).slice(0, 1200)}` : '',
      payload.customInstructions ? `\n【额外要求】\n${S(payload.customInstructions)}` : '',
      '',
      '【输出结构】',
      JSON.stringify({
        optimizedContent: '优化后的完整正文',
        optimizationPoints: ['具体改动点'],
        afterOptimizationAiRatio: 0,
        summary: '一句话说明改动思路',
      }, null, 2),
      '',
      jsonOnly(),
    ].filter(Boolean).join('\n');
  },
};

function buildPrompt(kind, payload) {
  const fn = B[String(kind || '').trim()];
  if (!fn) return `请根据以下信息完成「${S(kind)}」任务。\n\n${J(payload).slice(0, 6000)}`;
  try {
    return fn(payload || {});
  } catch (err) {
    return `请根据以下信息完成「${S(kind)}」任务。\n\n${J(payload).slice(0, 6000)}`;
  }
}

module.exports = { buildPrompt, KINDS: Object.keys(B) };
