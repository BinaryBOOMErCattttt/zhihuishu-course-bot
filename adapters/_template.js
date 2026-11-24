'use strict';
/**
 * 站点适配器模板
 *
 * 移植新站点时：
 *   1. 复制本文件为 adapters/<site>.js
 *   2. 填 selectors（唯一必须改的硬编码部分）
 *   3. 实现 15 个方法
 *   4. node tools/adapter-check.js adapters/<site>.js   ← 自检
 *   5. 按 docs/SPEC.md 第 15.2 节顺序验证
 *
 * 不要修改引擎（lib/generic/*）。若必须改，说明规范有缺口，补进 SPEC.md。
 */

module.exports = {
  // ============ 元信息 ============
  name: 'CHANGE_ME',              // 短 id，用于目录/日志
  displayName: 'CHANGE_ME',       // 显示名
  origin: 'https://CHANGE_ME',

  // ============ 选择器（唯一允许硬编码站点细节的地方）============
  selectors: {
    // 单元列表
    unitItem: '',        // 单元行容器
    unitTitle: '',       // 单元标题
    unitDone: '',        // 完成标记（图标/类名/文字）

    // 题目
    questionBlock: '',   // 单题容器
    questionStem: '',    // 题干
    questionType: '',    // 题型文字（含「多选」判定）
    optionRow: '',       // 选项行
    optionText: '',      // 选项文字
    optionIcon: '',      // 选中态图标（src 区分）

    // 答题卡 / 题头
    answerCard: '',      // 答题卡项（用于题号，替代 DOM 下标）
    partTitle: '',       // 「第1部分 总题数: N」

    // 导航
    prevBtn: '',
    nextBtn: '',
    submitBtn: '',

    // 解析页
    reviewBlock: '',
  },

  // 选中态特征串（图标 src 片段）。没有则留空，引擎回退到 input.checked / 类名
  selectedMarker: '',
  unselectedMarker: '',

  // ============ L1 浏览器 ============
  async launch(ctx) { throw new Error('TODO: launch'); },
  async isLoggedIn(page) { throw new Error('TODO: isLoggedIn'); },
  async gotoStudy(page) { throw new Error('TODO: gotoStudy'); },

  // ============ 单元 ============
  /** @returns {{key:string,index:number,title:string,duration?:string,platformDone:boolean}[]} */
  async listUnits(page) { throw new Error('TODO: listUnits'); },
  /** 打开后必须能被 getUnitTitle 校验通过 */
  async openUnit(page, index) { throw new Error('TODO: openUnit'); },
  async getUnitTitle(page) { throw new Error('TODO: getUnitTitle'); },
  /** @returns {{playing:boolean,ended:boolean,currentTime:number,duration:number}} */
  async playUnit(page, opts) { throw new Error('TODO: playUnit'); },
  async isPlatformDone(page, index) { throw new Error('TODO: isPlatformDone'); },
  /** @returns {{type:'quiz'|'captcha'|'dialog'|null, node?:any}} */
  async detectOverlay(page) { throw new Error('TODO: detectOverlay'); },

  // ============ 答题 ============
  async listTests(page) { throw new Error('TODO: listTests'); },
  async openTest(page, key) { throw new Error('TODO: openTest'); },
  /** 必须完整唯一，不能只取数字段 */
  async getExamId(page) { throw new Error('TODO: getExamId'); },
  async getQuestionCount(page) { throw new Error('TODO: getQuestionCount'); },
  /** 切到第 i 题（0 基），返回 true 表示确认切换成功 */
  async gotoQuestion(page, i) { throw new Error('TODO: gotoQuestion'); },
  /** @returns {{stem:string,options:string[],type:'radio'|'checkbox',checked:boolean[]}} */
  async readQuestion(page) { throw new Error('TODO: readQuestion'); },
  async selectOption(page, i) { throw new Error('TODO: selectOption'); },
  async readChecked(page) { throw new Error('TODO: readChecked'); },
  async submit(page) { throw new Error('TODO: submit'); },
  async openReview(page, key) { throw new Error('TODO: openReview'); },
  /** @returns {{i:number,result:'right'|'wrong',options:string[],correct:string[]}[]} */
  async readReview(page) { throw new Error('TODO: readReview'); },
};
