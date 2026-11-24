'use strict';
// 纯离线自主性测试：不联网、不调模型，验证题库能否独立完成全部判题与点击决策
const path=require('path');
const root=path.resolve(__dirname,'..');
const {Bot}=require(path.join(root,'lib/bot.js'));
const cfg=JSON.parse(require('fs').readFileSync(path.join(root,'config.json'),'utf8'));
// 断掉模型：指向不可达地址 + 空 key
const dead={...cfg, apiKey:'', baseUrl:'http://127.0.0.1:9/v1'};
const bot=new Bot({rootDir:root, config:dead, state:{completed:[],forcePending:[]}, onEvent:()=>{}});
const bank=bot.ensureQuizBank();
const rows=Object.values(bank.chapter||{});
const byExam={};
for(const v of rows){ (byExam[v.examId]=byExam[v.examId]||[]).push(v); }
let total=0, pass=0, fail=[];
const shuffle=(a)=>{const b=[...a];for(let i=b.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[b[i],b[j]]=[b[j],b[i]];}return b;};
for(const [examId, list] of Object.entries(byExam)){
  for(const v of list){
    for(let k=0;k<5;k++){
      const opts=shuffle(v.options||[]);
      const d=bot.lookupExamAnswer(examId, v.examIndex, opts, v.type);
      total++;
      const got=(d?d.indexes:[]).map(i=>opts[i]).map(s=>String(s).replace(/\s+/g,'')).sort().join('|');
      // 答案与题库答案做包含匹配（选项文本可能有尾随空格/标点差异）
      const want=(v.answers||[]).map(s=>String(s).replace(/\s+/g,'')).sort().join('|');
      if(got===want) pass++; else fail.push({examId:examId.slice(-12),i:v.examIndex,got:got.slice(0,60),want:want.slice(0,60)});
    }
  }
}
console.log(JSON.stringify({exams:Object.keys(byExam).length, questions:rows.length, trials:total, pass, failCount:fail.length, sample:fail.slice(0,3)},null,2));
