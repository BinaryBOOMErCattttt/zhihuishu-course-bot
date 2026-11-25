const path=require('path');
const root=path.resolve(__dirname,'..');
let config={};try{config=JSON.parse(require('fs').readFileSync(root+'/config.json','utf8'));}catch{}
const {Bot}=require(root+'/lib/bot.js');
let state={completed:[],forcePending:[]};try{state=JSON.parse(require('fs').readFileSync(root+'/data/state.json','utf8'));}catch{}
const bot=new Bot({rootDir:root,config,state,onEvent:()=>{}});
const bank=JSON.parse(require('fs').readFileSync(path.join(config.bankPath?path.resolve(root,config.bankPath):root+'/data/quiz-bank.json'),'utf8'));
let ok=0, fail=0;
for(const v of Object.values(bank.chapter||{})){
  const shuffled=[...v.options].reverse();
  const r=bot.lookupExamAnswer(v.examId,v.examIndex,shuffled,v.type);
  const got=(r?r.indexes:[]).map(i=>shuffled[i]).sort().join('|');
  const want=(v.answers||[]).slice().sort().join('|');
  if(got===want){ok++;} else {fail++; console.log('FAIL',v.examIndex,{got,want,shuffled});}
}
for(const v of Object.values(bank.popup||{})){
  const shuffled=[...v.options].reverse();
  const r=bot.lookupQuiz('popup',v.question,shuffled,v.type);
  const got=(r?r.indexes:[]).map(i=>shuffled[i]).sort().join('|');
  const want=(v.answers||[]).slice().sort().join('|');
  if(got===want){ok++;} else {fail++; console.log('POPUP FAIL',{got,want,shuffled});}
}
console.log('MAPPING_OK',ok,'FAIL',fail);
process.exit(fail?1:0);
