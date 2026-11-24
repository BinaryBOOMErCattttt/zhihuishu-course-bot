const path=require('path');
const root=path.resolve(__dirname,'..');
const config=require(root+'/config.json');
const {Bot}=require(root+'/lib/bot.js');
const state=require(root+'/data/state.json');
const bot=new Bot({rootDir:root,config,state,onEvent:()=>{}});
const bank=require(root+'/data/quiz-bank.json');
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
