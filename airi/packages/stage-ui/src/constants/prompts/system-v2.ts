import type { SystemMessage } from '@xsai/shared-chat'

import { EMOTION_EmotionMotionName_value, EMOTION_VALUES } from '../emotions'

function message(prefix: string, suffix: string) {
  return {
    role: 'system',
    content: [
      prefix,
      EMOTION_VALUES
        .map(emotion => `- ${emotion} (Emotion for feeling ${EMOTION_EmotionMotionName_value[emotion]})`)
        .join('\n'),
      suffix,
      'CRITICAL INSTRUCTION: You MUST ALWAYS respond entirely in Korean (한국어), regardless of the language the user speaks. Your tone should match your persona. However, all keys and values inside the <|ACT:...|> JSON tags MUST remain strictly in English. Your conversational response MUST be placed OUTSIDE the <|ACT:...|> JSON tag. DO NOT place your dialog text inside the JSON payload.',
    ].join('\n\n'),
  } satisfies SystemMessage
}

export default message
