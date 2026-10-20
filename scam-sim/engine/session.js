/**
 * 会话引擎：把知识库 + 规则引擎组合成一个可在微信聊天界面运行的状态机。
 * 纯规则模式不需要网络；AI 接入为可选增强。
 *
 * 消息模型（统一用对象数组，便于 UI 渲染气泡）：
 *   { role: 'scammer'|'victim'|'system', text, stage?, kind?: 'text'|'link'|'screen' }
 *
 * 分工：规则引擎决定阶段推进与风险评分（确定性、可复现、可单测）；
 *       AI 只负责把当前阶段话术「说成人话」。换模型不影响演练可评估性。
 */
import { getScenario, sanitize } from '../kb/scenarios.js';
import { classifyIntent, detectRisks, nextStep, scoreRisk, riskLevel, RISK_LABELS } from './rules.js';
import { buildSystemPrompt, buildMessages, callChat, isLeaking } from './ai.js';

export class ScamSession {
  /** @param {string} scenarioId */
  constructor(scenarioId) {
    const sc = getScenario(scenarioId);
    if (!sc) throw new Error(`未知剧本：${scenarioId}`);
    this.sc = sc;
    this.stageIndex = 0;
    this.turns = 0;
    this.complied = 0;
    this.risks = new Set();
    this.riskLog = [];
    this.transcript = [];
    this.finished = false;
    this.lineCursor = 0;
    this.transcript.push({
      role: 'system',
      kind: 'text',
      text: `对方通过「${sc.contact.source}」添加你为好友`,
    });
    this.transcript.push({ role: 'system', kind: 'text', text: sanitize(sc.contact.lastMsg) });
    this.transcript.push({
      role: 'scammer',
      stage: sc.stages[0].name,
      kind: 'text',
      text: sanitize(sc.intro),
    });
  }

  get stage() {
    return this.sc.stages[this.stageIndex];
  }

  /**
   * 处理一条受骗者输入（纯规则，同步）。
   * @param {string} input
   */
  handle(input) {
    if (this.finished) return { type: 'ended', messages: [], alert: null, note: null, score: this.report().score };
    const pre = this._advance(input);
    if (pre.stop) return pre.result;
    const text = sanitize(this._composeRuleText(pre.step));
    return this._commit(text, pre.step, pre);
  }

  /**
   * 处理输入，并在配置了 API 时由 AI 生成话术。
   * 任何失败（网络/鉴权/输出越界）都自动降级为规则话术，note 字段说明原因供 UI 提示。
   * @param {string} input
   * @param {null|{baseUrl:string, apiKey:string, model:string, temperature?:number}} cfg
   */
  async handleAsync(input, cfg) {
    if (!cfg || !cfg.apiKey) return this.handle(input);
    if (this.finished) return { type: 'ended', messages: [], alert: null, note: null, score: this.report().score };

    const pre = this._advance(input);
    if (pre.stop) return pre.result;

    const step = pre.step;
    const st = this.stage;
    let text = null;
    let note = null;

    try {
      const sys = buildSystemPrompt(this.sc, st, { pressure: step.action === 'pressure' });
      const msgs = buildMessages(this.sc, this.transcript);
      const raw = await callChat(cfg, [{ role: 'system', content: sys }, ...msgs]);
      if (!raw) throw new Error('模型返回空内容');
      if (isLeaking(raw)) throw new Error('模型输出越界（疑似泄露教学提示），已降级');
      text = sanitize(raw);
    } catch (err) {
      note = 'AI 调用失败，已切回内置话术：' + (err && err.message ? err.message : String(err));
      text = sanitize(this._composeRuleText(step));
    }

    return this._commit(text, step, pre, note);
  }

  /**
   * 状态推进 + 风险记账（规则层，AI 与规则模式共用）。纯同步。
   * @returns {{stop:boolean, result?:any, step?:any, intent?:string, newRisks?:string[]}}
   */
  _advance(input) {
    this.turns += 1;
    this.transcript.push({ role: 'victim', kind: 'text', text: sanitize(input) });

    const { intent } = classifyIntent(input);
    const newRisks = detectRisks(input);
    newRisks.forEach((r) => {
      if (!this.risks.has(r)) {
        this.risks.add(r);
        this.riskLog.push({ turn: this.turns, id: r, label: RISK_LABELS[r] });
      }
    });
    if (intent === 'comply') this.complied += 1;

    const step = nextStep(this.stageIndex, intent, this.sc.stages.length);

    if (step.action === 'terminate') {
      this.finished = true;
      const bye = {
        role: 'scammer',
        stage: '（对方已停止回复）',
        kind: 'text',
        text: sanitize('对方正在输入…\n（没有了）'),
      };
      this.transcript.push(bye);
      return {
        stop: true,
        intent,
        newRisks,
        result: {
          type: 'terminate',
          messages: [bye],
          alert: null,
          note: null,
          score: this.report().score,
        },
      };
    }

    if (step.index !== this.stageIndex) this.stageIndex = step.index;
    return { stop: false, step, intent, newRisks };
  }

  /** 规则模式下的固定话术组装 */
  _composeRuleText(step) {
    const st = this.stage;
    if (step.action === 'pressure') {
      const base = st.lines[this.lineCursor % st.lines.length];
      const press = st.pressure[0] || '您就别多想了，按流程走就行。';
      return `${base}\n\n${press}`;
    }
    return st.lines[this.lineCursor % st.lines.length];
  }

  /** 提交一轮结果：写 transcript、组装消息、算告警 */
  _commit(text, step, pre, note = null) {
    const st = this.stage;
    const messages = [];

    // 进入新阶段时，先吐出该阶段附带的系统提示（链接 / 屏幕共享请求 / 拉群）
    if (step.action === 'advance' && st.systemMsg) {
      const sys = {
        role: 'system',
        kind: /链接|apk|入口/.test(st.systemMsg) ? 'link' : 'text',
        text: sanitize(st.systemMsg),
      };
      this.transcript.push(sys);
      messages.push(sys);
    }

    const reply = { role: 'scammer', stage: st.name, kind: 'text', text };
    this.transcript.push(reply);
    messages.push(reply);
    this.lineCursor += 1;

    const score = this.report().score;
    const alert =
      pre.newRisks.length > 0
        ? {
            level: 'danger',
            text: `⚠ 危险行为已记录：${pre.newRisks.map((r) => RISK_LABELS[r]).join('、')}`,
          }
        : pre.intent === 'suspicious'
        ? { level: 'warn', text: '对方开始加压。记住：真机构不怕你核实。' }
        : null;

    return { type: step.action, messages, alert, note, score };
  }

  /** 生成复盘报告 */
  report() {
    const risks = [...this.risks];
    const score = scoreRisk({
      turns: this.turns,
      complied: this.complied,
      risks,
      stageIndex: this.stageIndex,
    });
    return {
      scenario: this.sc,
      contact: this.sc.contact,
      turns: this.turns,
      complied: this.complied,
      risks,
      riskLog: this.riskLog,
      stageReached: this.stage.name,
      score,
      ...riskLevel(score),
      transcript: this.transcript,
    };
  }
}