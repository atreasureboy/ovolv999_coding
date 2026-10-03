import type { SlashCommandResult } from './index.js'

export const text = (value: string): SlashCommandResult => ({ type: 'text', value })
