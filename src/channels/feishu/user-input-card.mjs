const md = content => ({ tag:'markdown', content });
const plain = content => ({ tag:'plain_text', content });

export function renderUserInputCard(userInput, { displayName='agent-chat-bridge', terminal }={}) {
  const elements=[];
  if(terminal){
    elements.push(md(terminal==='submitted'?'**回答已提交。**':terminal==='unknown'?'**提交状态未确认，请勿重复提交。**':'**该提问已失效。**'));
  }else{
    const fields=[];
    userInput.questions.forEach((question,index)=>{
      fields.push(md(`**${question.header}**\n${question.question}`));
      if(question.options.length){
        fields.push({tag:'select_static',name:`q_${index}_choice`,placeholder:plain('请选择'),required:!question.isOther,
          options:question.options.map((option,optionIndex)=>({text:plain(option.description?`${option.label} · ${option.description}`:option.label),value:`o_${optionIndex}`}))});
      }
      if(!question.options.length||question.isOther){
        fields.push({tag:'input',name:`q_${index}_other`,placeholder:plain(question.options.length?'其他（请填写）':'请输入回答'),
          input_type:'multiline_text',max_length:1000,required:!question.options.length});
      }
    });
    fields.push({tag:'button',name:'submit_user_input',text:plain('提交回答'),type:'primary_filled',form_action_type:'submit',
      value:{action:'submit_user_input',jobId:userInput.jobId,requestKey:userInput.requestKey,itemId:userInput.itemId}});
    elements.push({tag:'form',name:'codex_user_input',elements:fields});
  }
  const card={schema:'2.0',config:{update_multi:true,summary:{content:`${displayName} · Codex 提问`}},
    header:{template:terminal==='expired'?'grey':terminal==='unknown'?'orange':'blue',title:plain(`${displayName} · 需要你的回答`)},body:{elements}};
  if(Buffer.byteLength(JSON.stringify(card))>28000)throw Object.assign(new Error('user input card exceeds budget'),{code:'user_input_card_too_large'});
  return card;
}

export function answersFromForm(userInput, formValue) {
  if(!formValue||typeof formValue!=='object'||Array.isArray(formValue))throw Object.assign(new Error('invalid form'),{code:'invalid_user_input'});
  const allowed=new Set(); const answers=Object.create(null);
  userInput.questions.forEach((question,index)=>{
    const choiceName=`q_${index}_choice`; const otherName=`q_${index}_other`; allowed.add(choiceName); allowed.add(otherName);
    const choice=formValue[choiceName]; const other=formValue[otherName];
    if(choice!=null&&typeof choice!=='string')throw Object.assign(new Error('invalid choice'),{code:'invalid_user_input'});
    if(other!=null&&typeof other!=='string')throw Object.assign(new Error('invalid text'),{code:'invalid_user_input'});
    const note=String(other||'').trim();
    if(note&&choice)throw Object.assign(new Error('choose an option or fill other'),{code:'invalid_user_input'});
    let answer;
    if(note)answer=`user_note: ${note}`;
    else if(choice&&/^o_\d+$/.test(choice))answer=question.options[Number(choice.slice(2))]?.label;
    if(!answer)throw Object.assign(new Error('answer required'),{code:'invalid_user_input'});
    Object.defineProperty(answers,question.id,{value:{answers:[answer]},enumerable:true});
  });
  if(Object.keys(formValue).some(key=>!allowed.has(key)))throw Object.assign(new Error('unexpected form field'),{code:'invalid_user_input'});
  return answers;
}
