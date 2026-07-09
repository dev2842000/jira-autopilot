import Anthropic from '@anthropic-ai/sdk'
import { CONFIG } from '../config.js'

function uniqueModels(primary) {
  return [...new Set([primary, ...(CONFIG.modelFallbacks ?? [])].filter(Boolean))]
}

function isModelNotFound(error) {
  return error?.status === 404
    && String(error?.error?.error?.message ?? error?.message ?? '').includes('model:')
}

export function createAnthropicClient() {
  const apiKey = process.env.ANTHROPIC_API_KEY ?? null
  const authToken = process.env.ANTHROPIC_AUTH_TOKEN ?? null

  if (!apiKey && !authToken) {
    throw new Error('Missing Anthropic credentials. Set ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN, then restart the agent runner.')
  }

  const client = new Anthropic({ apiKey, authToken })
  const create = client.messages.create.bind(client.messages)

  client.messages.create = async (params, options) => {
    let lastError
    for (const model of uniqueModels(params.model)) {
      try {
        return await create({ ...params, model }, options)
      } catch (error) {
        lastError = error
        if (!isModelNotFound(error)) throw error
        console.warn(`Anthropic model not found: ${model}. Trying next fallback.`)
      }
    }
    throw lastError
  }

  return client
}
