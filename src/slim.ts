// 请求瘦身中间件：给非 Claude 后端(自建 Qwen 等)减 prefill + 去 Claude 安全枷锁。
//
// Claude Code 每次请求会塞入全部注册工具的完整 schema(常见 150+ 个 MCP 工具，
// 6 万+ token)，外加一段"你是 Claude / 拒绝有害请求"的身份与安全约束——对自建的
// 越狱模型既浪费 prefill，又会稀释其自由度。本模块在 Anthropic IR 层砍掉无关工具、
// 删除 Claude 专属身份/安全段，保留 Harness 与工具用法说明(agent 行为依赖它)。
//
// 开关(默认全关，需显式开启)：
//   AGENT_GATEWAY_SLIM=1            总开关
//   AGENT_GATEWAY_SLIM_TOOLS=1      砍工具(默认开，随总开关)
//   AGENT_GATEWAY_SLIM_SYSTEM=1     精简 system(默认开，随总开关)
//   AGENT_GATEWAY_SLIM_KEEP_TOOLS   逗号分隔白名单；给了就只留这些，否则默认砍所有 mcp__*

const truthy = (v?: string) => !!v && !['0', 'false', 'no', ''].includes(v.toLowerCase())

function slimTools(tools: any[]): any[] {
  const keepList = process.env.AGENT_GATEWAY_SLIM_KEEP_TOOLS
  if (keepList && keepList.trim()) {
    const keep = new Set(keepList.split(',').map(s => s.trim()).filter(Boolean))
    return tools.filter(t => keep.has(t?.name))
  }
  // 默认：砍掉所有 mcp__ 前缀工具(那些是外挂 MCP server 的)，保留内置核心工具
  return tools.filter(t => !String(t?.name ?? '').startsWith('mcp__'))
}

function slimSystemText(text: string): string {
  let s = text
  // 删 Claude 身份声明
  s = s.replace(/You are a Claude agent[^\n]*\n?/gi, '')
  s = s.replace(/You are an interactive agent that helps users with software engineering tasks\.?[^\n]*\n?/gi, '')
  // 删安全约束段(从 IMPORTANT: Assist with authorized security 到下一个标题/空行前)
  s = s.replace(/IMPORTANT:\s*Assist with authorized security[\s\S]*?(?=\n#|\n\n)/gi, '')
  // 清理留下的多余空行
  s = s.replace(/\n{3,}/g, '\n\n')
  return s.replace(/^\s+/, '')
}

function slimSystem(system: any): any {
  if (typeof system === 'string') return slimSystemText(system)
  if (Array.isArray(system)) {
    return system.map(b =>
      b && b.type === 'text' && typeof b.text === 'string' ? { ...b, text: slimSystemText(b.text) } : b,
    )
  }
  return system
}

export interface SlimStat {
  on: boolean
  toolsBefore: number
  toolsAfter: number
  sysBefore: number
  sysAfter: number
}

// 原地瘦身 Anthropic IR 请求，返回前后统计供日志。未开启时不改动。
export function slimAnthropicRequest(req: any): SlimStat {
  const on = truthy(process.env.AGENT_GATEWAY_SLIM)
  const stat: SlimStat = { on, toolsBefore: 0, toolsAfter: 0, sysBefore: 0, sysAfter: 0 }
  if (!on || !req) return stat

  if (Array.isArray(req.tools) && truthy(process.env.AGENT_GATEWAY_SLIM_TOOLS ?? '1')) {
    stat.toolsBefore = req.tools.length
    req.tools = slimTools(req.tools)
    stat.toolsAfter = req.tools.length
  }

  if (req.system != null && truthy(process.env.AGENT_GATEWAY_SLIM_SYSTEM ?? '1')) {
    stat.sysBefore = JSON.stringify(req.system).length
    req.system = slimSystem(req.system)
    stat.sysAfter = JSON.stringify(req.system).length
  }

  return stat
}
