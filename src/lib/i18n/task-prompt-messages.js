const taskPromptMessages = {
  en: {
    "taskPrompt.confirmRegistration": "Would you like me to register this as a task?",
    "taskPrompt.coreConfirmInstruction": 'When you detect a task, ALWAYS confirm first: "{confirmation}" and wait for approval before creating.',
    "taskPrompt.reminderHeader": "When you detect a work instruction, you must:",
    "taskPrompt.reminderConfirmStep": '1. First ask "{confirmation}"',
    "taskPrompt.reminderCreateStep": "2. After approval, generate a json:task block in the EXACT format below (no other structure allowed):",
    "taskPrompt.reminderRequiredFields": "Required fields: action(create/update/complete/cancel), id, title, status, summary",
    "taskPrompt.reminderAllowedFields": "Do not add fields other than these five. Put scope/priority/due details inside the summary text.",
    "taskPrompt.reminderIgnoreCasual": "Do not create task blocks for casual conversation or simple questions.",
  },
  ko: {
    "taskPrompt.confirmRegistration": "이 작업을 태스크로 등록할까요?",
    "taskPrompt.coreConfirmInstruction": 'When you detect a task, ALWAYS confirm first: "{confirmation}" and wait for approval before creating.',
    "taskPrompt.reminderHeader": "업무 지시 감지 시 반드시:",
    "taskPrompt.reminderConfirmStep": '1. 먼저 "{confirmation}" 확인',
    "taskPrompt.reminderCreateStep": "2. 승인 후 아래 EXACT 포맷의 json:task 블록 생성 (다른 구조 금지):",
    "taskPrompt.reminderRequiredFields": "필수 필드: action(create/update/complete/cancel), id, title, status, summary",
    "taskPrompt.reminderAllowedFields": "이 5개 필드 외 다른 필드를 넣지 마세요. scope/priority/due 등은 summary 텍스트 안에 포함하세요.",
    "taskPrompt.reminderIgnoreCasual": "일반 대화/질문에는 태스크 블록을 생성하지 마세요.",
  },
  ja: {
    "taskPrompt.confirmRegistration": "この作業をタスクとして登録しますか？",
    "taskPrompt.coreConfirmInstruction": 'When you detect a task, ALWAYS confirm first: "{confirmation}" and wait for approval before creating.',
    "taskPrompt.reminderHeader": "業務指示を検知したら必ず:",
    "taskPrompt.reminderConfirmStep": '1. まず「{confirmation}」を確認',
    "taskPrompt.reminderCreateStep": "2. 承認後、以下の EXACT 形式で json:task ブロックを生成すること（他の構造は禁止）:",
    "taskPrompt.reminderRequiredFields": "必須フィールド: action(create/update/complete/cancel), id, title, status, summary",
    "taskPrompt.reminderAllowedFields": "この5項目以外のフィールドを追加しないでください。scope/priority/due などは summary の文章内に含めてください。",
    "taskPrompt.reminderIgnoreCasual": "雑談や簡単な質問にはタスクブロックを生成しないでください。",
  },
  zh: {
    "taskPrompt.confirmRegistration": "要把这项工作登记为任务吗？",
    "taskPrompt.coreConfirmInstruction": 'When you detect a task, ALWAYS confirm first: "{confirmation}" and wait for approval before creating.',
    "taskPrompt.reminderHeader": "检测到工作指示时必须：",
    "taskPrompt.reminderConfirmStep": '1. 先确认“{confirmation}”',
    "taskPrompt.reminderCreateStep": "2. 获得批准后，按下面的 EXACT 格式生成 json:task 代码块（禁止使用其他结构）：",
    "taskPrompt.reminderRequiredFields": "必填字段：action(create/update/complete/cancel), id, title, status, summary",
    "taskPrompt.reminderAllowedFields": "不要添加这五个字段以外的内容。scope/priority/due 等信息请写进 summary 文本里。",
    "taskPrompt.reminderIgnoreCasual": "普通对话或简单问题不要生成任务代码块。",
  },
};

module.exports = { taskPromptMessages };
