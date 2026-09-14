const text = (value, max, field) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw Object.assign(new Error(`invalid ${field}`), { code: 'CODEX_USER_INPUT_INVALID' });
  return value;
};

export const typedRequestKey = id => `${typeof id}:${JSON.stringify(id)}`;

export function normalizeUserInputRequest(request) {
  const params = request?.params;
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw Object.assign(new Error('invalid request params'), { code: 'CODEX_USER_INPUT_INVALID' });
  const threadId = text(params.threadId, 255, 'thread id');
  const turnId = text(params.turnId, 255, 'turn id');
  const itemId = text(params.itemId, 255, 'item id');
  if (!Array.isArray(params.questions) || params.questions.length < 1 || params.questions.length > 3) throw Object.assign(new Error('invalid question count'), { code: 'CODEX_USER_INPUT_INVALID' });
  if (params.questions.some(question => question?.isSecret === true)) throw Object.assign(new Error('secret questions are unsupported'), { code: 'CODEX_USER_INPUT_SECRET_UNSUPPORTED' });
  const ids = new Set();
  const questions = params.questions.map((question) => {
    if (!question || typeof question !== 'object' || Array.isArray(question)) throw Object.assign(new Error('invalid question'), { code: 'CODEX_USER_INPUT_INVALID' });
    const id = text(question.id, 128, 'question id');
    if (ids.has(id)) throw Object.assign(new Error('duplicate question id'), { code: 'CODEX_USER_INPUT_INVALID' });
    ids.add(id);
    const header = text(question.header, 80, 'question header');
    const prompt = text(question.question, 2_000, 'question');
    const rawOptions = question.options == null ? [] : question.options;
    if (!Array.isArray(rawOptions) || rawOptions.length > 20) throw Object.assign(new Error('invalid options'), { code: 'CODEX_USER_INPUT_INVALID' });
    const values = new Set();
    const options = rawOptions.map((option) => {
      const label = text(option?.label, 200, 'option label');
      if (values.has(label)) throw Object.assign(new Error('duplicate option label'), { code: 'CODEX_USER_INPUT_INVALID' });
      values.add(label);
      if(option?.description!==undefined&&(typeof option.description!=='string'||option.description.length>500))throw Object.assign(new Error('invalid option description'),{code:'CODEX_USER_INPUT_INVALID'});
      return { label, description: option.description || '' };
    });
    if (question.isOther !== undefined && typeof question.isOther !== 'boolean') throw Object.assign(new Error('invalid other flag'), { code: 'CODEX_USER_INPUT_INVALID' });
    return { id, header, question: prompt, options, isOther: question.isOther === true };
  });
  return { requestId: request.requestId, threadId, turnId, itemId, questions, isBlocking: params.isBlocking === true };
}

export function normalizeUserInputAnswers(questions, answers) {
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) throw Object.assign(new Error('answers are required'), { code: 'CODEX_USER_INPUT_INVALID' });
  const result = Object.create(null);
  for (const question of questions) {
    const answer = answers[question.id];
    if (!answer || !Array.isArray(answer.answers) || answer.answers.length !== 1) throw Object.assign(new Error('one answer is required'), { code: 'CODEX_USER_INPUT_INVALID' });
    const value = text(answer.answers[0], 1_011, 'answer');
    if (question.options.length && !question.options.some(option => option.label === value) && !(question.isOther && value.startsWith('user_note: '))) {
      throw Object.assign(new Error('answer is not an offered option'), { code: 'CODEX_USER_INPUT_INVALID' });
    }
    if (!question.options.length && !value.startsWith('user_note: ')) throw Object.assign(new Error('free-form answer is invalid'), { code: 'CODEX_USER_INPUT_INVALID' });
    Object.defineProperty(result, question.id, { value: { answers: [value] }, enumerable: true });
  }
  if (Object.keys(answers).length !== questions.length) throw Object.assign(new Error('unexpected answer'), { code: 'CODEX_USER_INPUT_INVALID' });
  return { answers: result };
}
