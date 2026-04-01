/**
 * commands.ts — Slash commands and role management for PinchCord.
 *
 * Registers Discord Application Commands:
 *   /bee, /beaver, /fox, /badger, /owl — send tasks to specific bots
 *   /status — show fleet status via Discord presence
 *   /restart <bot> — write restart marker file
 *
 * Also provides role management helpers for assigning/removing Discord roles.
 *
 * Slash command delivery: task posts publicly in channel, bot creates a thread
 * for the work, posts summary back to channel when done.
 *
 * If this file is absent, no slash commands are registered.
 */

import {
  Client,
  REST,
  Routes,
  SlashCommandBuilder,
  type Interaction,
  type ChatInputCommandInteraction,
  PermissionFlagsBits,
  type GuildMember,
} from 'discord.js'
import { writeFileSync, existsSync, readFileSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const STATE_DIR = process.env.DISCORD_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'discord')
const BOT_NAMES = ['bee', 'beaver', 'fox', 'badger', 'owl'] as const
type BotName = typeof BOT_NAMES[number]

let discordClient: Client | null = null

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initialize slash commands. Registers commands with Discord and sets up
 * the interaction handler.
 */
export async function init(client: Client): Promise<void> {
  discordClient = client

  // Register slash commands
  if (client.user && client.token) {
    try {
      await registerCommands(client.token, client.user.id)
      process.stderr.write('pinchcord commands: slash commands registered\n')
    } catch (err) {
      process.stderr.write(`pinchcord commands: failed to register slash commands: ${err}\n`)
    }
  }

  // Handle slash command interactions
  client.on('interactionCreate', async (interaction: Interaction) => {
    if (!interaction.isChatInputCommand()) return
    try {
      await handleCommand(interaction)
    } catch (err) {
      process.stderr.write(`pinchcord commands: interaction failed: ${err}\n`)
      try {
        if (interaction.replied || interaction.deferred) {
          await interaction.followUp({ content: `Command failed: ${err}`, ephemeral: true })
        } else {
          await interaction.reply({ content: `Command failed: ${err}`, ephemeral: true })
        }
      } catch { /* give up */ }
    }
  })
}

// ---------------------------------------------------------------------------
// Role management
// ---------------------------------------------------------------------------

/**
 * Assign a role to a member.
 * @param guildId The guild to operate in
 * @param userId The user to assign the role to
 * @param roleId The role to assign
 */
export async function assignRole(guildId: string, userId: string, roleId: string): Promise<void> {
  if (!discordClient) throw new Error('commands module not initialized')
  const guild = await discordClient.guilds.fetch(guildId)
  const member = await guild.members.fetch(userId)
  await member.roles.add(roleId)
}

/**
 * Remove a role from a member.
 */
export async function removeRole(guildId: string, userId: string, roleId: string): Promise<void> {
  if (!discordClient) throw new Error('commands module not initialized')
  const guild = await discordClient.guilds.fetch(guildId)
  const member = await guild.members.fetch(userId)
  await member.roles.remove(roleId)
}

// ---------------------------------------------------------------------------
// Internal — command registration
// ---------------------------------------------------------------------------

async function registerCommands(token: string, appId: string): Promise<void> {
  const rest = new REST({ version: '10' }).setToken(token)

  // Only the first bot to register should own commands — controlled by env var.
  // Other bots skip registration to avoid overwriting each other's commands.
  const shouldRegister = process.env.PINCHCORD_REGISTER_COMMANDS === 'true'
  if (!shouldRegister) {
    process.stderr.write('pinchcord commands: PINCHCORD_REGISTER_COMMANDS not set, skipping registration\n')
    return
  }

  const guildId = process.env.PINCHCORD_GUILD_ID
  if (!guildId) {
    process.stderr.write('pinchcord commands: PINCHCORD_GUILD_ID required for command registration\n')
    return
  }

  const botCommands = BOT_NAMES.map(name =>
    new SlashCommandBuilder()
      .setName(name)
      .setDescription(`Send a task to ${name.charAt(0).toUpperCase() + name.slice(1)}`)
      .addStringOption(opt =>
        opt.setName('task').setDescription('The task to assign').setRequired(true),
      )
      .toJSON(),
  )

  const statusCommand = new SlashCommandBuilder()
    .setName('status')
    .setDescription('Show bot fleet status')
    .toJSON()

  const restartCommand = new SlashCommandBuilder()
    .setName('restart')
    .setDescription('Restart a bot')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(opt =>
      opt
        .setName('bot')
        .setDescription('Which bot to restart')
        .setRequired(true)
        .addChoices(...BOT_NAMES.map(n => ({ name: n, value: n }))),
    )
    .toJSON()

  // Guild-scoped commands — propagate instantly, don't conflict between bots
  await rest.put(Routes.applicationGuildCommands(appId, guildId), {
    body: [...botCommands, statusCommand, restartCommand],
  })
}

// ---------------------------------------------------------------------------
// Internal — command handlers
// ---------------------------------------------------------------------------

async function handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const name = interaction.commandName

  // Bot task commands
  if (BOT_NAMES.includes(name as BotName)) {
    const task = interaction.options.getString('task', true)
    const botDisplayName = name.charAt(0).toUpperCase() + name.slice(1)

    // Post the task publicly
    const callerName = interaction.user.globalName ?? interaction.user.username
    await interaction.reply(
      `**${callerName} -> ${botDisplayName}:** ${task}`,
    )
    return
  }

  // Status command
  if (name === 'status') {
    const statusLines: string[] = ['**Bot Fleet Status:**\n']

    for (const botName of BOT_NAMES) {
      const statusFile = join(STATE_DIR, `.status-${botName}.json`)
      try {
        if (existsSync(statusFile)) {
          const raw = readFileSync(statusFile, 'utf8')
          const status = JSON.parse(raw) as {
            status: string
            uptime: number
            lastHeartbeat: string
            gateway: string
          }
          const uptimeMin = Math.floor(status.uptime / 60)
          const heartbeatAge = Math.floor(
            (Date.now() - new Date(status.lastHeartbeat).getTime()) / 1000,
          )
          const stale = heartbeatAge > 120 ? ' (stale)' : ''
          statusLines.push(
            `**${botName.charAt(0).toUpperCase() + botName.slice(1)}:** ${status.status} | Up ${uptimeMin}m | Gateway: ${status.gateway}${stale}`,
          )
        } else {
          statusLines.push(
            `**${botName.charAt(0).toUpperCase() + botName.slice(1)}:** No heartbeat file (offline or heartbeat disabled)`,
          )
        }
      } catch {
        statusLines.push(
          `**${botName.charAt(0).toUpperCase() + botName.slice(1)}:** Error reading status`,
        )
      }
    }

    await interaction.reply({ content: statusLines.join('\n'), ephemeral: true })
    return
  }

  // Restart command
  if (name === 'restart') {
    const botName = interaction.options.getString('bot', true) as BotName
    const markerFile = join(STATE_DIR, `.restart-${botName}`)
    mkdirSync(STATE_DIR, { recursive: true })
    writeFileSync(markerFile, new Date().toISOString())
    await interaction.reply(
      `Restart marker written for **${botName}**. It will restart within 60 seconds (if heartbeat is active).`,
    )
    return
  }

  await interaction.reply({ content: `Unknown command: ${name}`, ephemeral: true })
}
