/** Adapt the host fish tools for a per-run MCP capability, not a general tool executor. */
export function backgroundToolNames(cfg = {}) {
  const names = ['bili_whoami', 'bili_search', 'bili_subtitle', 'bili_comments', 'bili_video_info', 'bili_danmaku', 'bili_buzzwords', 'bili_rank', 'bili_hot_videos', 'bili_user_videos', 'bili_seen', 'bili_say', 'bili_pace', 'bili_my_notices', 'bili_my_dynamics', 'bili_opus_comments', 'bili_my_video_comments', 'bili_learn', 'bili_soul', 'bili_taste', 'bili_records', 'bili_sticker']
  if (cfg.autoComment || cfg.replyToComments) names.push('bili_reply', 'bili_reply_opus')
  // 「自动评论视频」开着才给发新评论的通道；回复另算（replyToComments）。
  // 🐋 后台白名单收窄（规格 §5.4）：无人值守只放行 bili_book_comment（书源门+宿主注入，
  //    无链接评论发不出去）；普通新评论 bili_comment 只保留在会话态。bili_reply 仍由
  //    autoComment || replyToComments 门控，但后台 expose 时强制 rpid 必填（见 exposeBackgroundTools）。
  if (cfg.autoComment) names.push('bili_book_comment')
  if (cfg.replyToComments) names.push('bili_received_replies')
  if (cfg.autoMoment) names.push('bili_moment')
  if (cfg.autoReplyDm) names.push('bili_dm_inbox', 'bili_dm_thread', 'bili_dm_reply')
  if (['only', 'both'].includes(cfg.dmMode) && cfg.dmUid) names.push('bili_deliver')
  return names
}
export function toolInputSchema(parameters = {}) {
  const properties = {}, required = []
  for (const [key, field] of Object.entries(parameters)) {
    // force is direct-human authorization, never available in an unattended run.
    if (key === 'force') continue
    const { required: mandatory, ...schema } = field
    properties[key] = schema
    if (mandatory) required.push(key)
  }
  return { type: 'object', properties, required, additionalProperties: false }
}
export function validateToolArguments(schema, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('BACKGROUND_TOOL_ARGUMENTS_REQUIRED')
  for (const key of Object.keys(args)) if (!Object.hasOwn(schema.properties, key)) throw new Error('BACKGROUND_TOOL_UNKNOWN_ARGUMENT: ' + key)
  for (const key of schema.required) if (!Object.hasOwn(args, key) || args[key] === null) throw new Error('BACKGROUND_TOOL_REQUIRED_ARGUMENT: ' + key)
  const out = {}
  for (const [key, value] of Object.entries(args)) {
    if (value === null) continue // optional strict-mode nullable sentinel
    const field = schema.properties[key]
    const good = field.type === 'array' ? Array.isArray(value) && value.every(x => typeof x === (field.items?.type || 'string')) : field.type === 'number' ? typeof value === 'number' && Number.isFinite(value) : typeof value === field.type
    if (!good || (field.enum && !field.enum.includes(value))) throw new Error('BACKGROUND_TOOL_INVALID_ARGUMENT: ' + key)
    out[key] = value
  }
  return out
}
export function exposeBackgroundTools(registry, cfg, execute) {
  return backgroundToolNames(cfg).filter(name => registry.has(name)).map(name => {
    const spec = registry.get(name), inputSchema = toolInputSchema(spec.parameters)
    // 🐋 §5.4 的机器保证（配合 index.js 后台回调里的 rpid 拦截）：模型看见的后台 schema 里
    //    bili_reply 的 rpid 必填 ⇒ 后台没有"发新评论"的通道，唯一新评论入口是 bili_book_comment。
    //    ⚠️ 调用校验仍用宿主原始 schema（rpid 可缺省），让"开关关着 → BACKGROUND_TOOL_DISABLED"
    //    的既有语义先发生；拦截在白名单检查之后做。
    const exposedSchema = name === 'bili_reply' && !inputSchema.required.includes('rpid')
      ? { ...inputSchema, required: [...inputSchema.required, 'rpid'] }
      : inputSchema
    return { name, description: spec.description, inputSchema: exposedSchema, execute: async (args, signal) => execute(name, validateToolArguments(inputSchema, args), signal) }
  })
}
