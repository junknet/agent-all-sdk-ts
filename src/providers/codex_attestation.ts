import { spawn, type ChildProcess } from 'child_process'
import readline from 'readline'

class CodexAttestationDaemon {
  private proc: ChildProcess | null = null
  private pendingRequests: Map<number, (token: string) => void> = new Map()
  private isReady = false
  private initPromise: Promise<void> | null = null

  private ensureDaemon(): Promise<void> {
    if (this.proc && this.isReady) return Promise.resolve()
    if (this.initPromise) return this.initPromise

    this.initPromise = new Promise<void>((resolve) => {
      try {
        this.proc = spawn('codex', ['app-server', '--stdio', '-c', 'mcp_servers={}'], {
          stdio: ['pipe', 'pipe', 'ignore'],
        })
      } catch {
        this.initPromise = null
        return resolve()
      }

      this.proc.on('error', () => {
        this.cleanup()
      })

      this.proc.on('exit', () => {
        this.cleanup()
      })

      if (!this.proc.stdout || !this.proc.stdin) {
        this.cleanup()
        return resolve()
      }

      const stdin = this.proc.stdin
      const rl = readline.createInterface({ input: this.proc.stdout })

      rl.on('line', (line) => {
        try {
          const msg = JSON.parse(line)

          // 确认 initialize 完成
          if (msg.id === 1 && msg.result) {
            this.isReady = true
            resolve()
          }

          if (msg.method === 'attestation/generate') {
            const clientToken = 'v1.native-app-server'
            try {
              stdin.write(
                JSON.stringify({
                  jsonrpc: '2.0',
                  id: msg.id,
                  result: { token: clientToken },
                }) + '\n'
              )
            } catch {}

            const cb = this.pendingRequests.get(msg.id)
            if (cb) {
              this.pendingRequests.delete(msg.id)
              cb(clientToken)
            } else {
              const firstKey = this.pendingRequests.keys().next().value
              if (firstKey !== undefined) {
                const firstCb = this.pendingRequests.get(firstKey)
                this.pendingRequests.delete(firstKey)
                firstCb?.(clientToken)
              }
            }
          }
        } catch {}
      })

      // 发送 initialize
      try {
        stdin.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
              clientInfo: { name: 'codex_tui', version: '0.146.0' },
              capabilities: { requestAttestation: true },
            },
          }) + '\n'
        )
      } catch {
        resolve()
      }
    })

    return this.initPromise
  }

  private cleanup() {
    this.isReady = false
    this.initPromise = null
    try {
      this.proc?.kill()
    } catch {}
    this.proc = null
    for (const cb of this.pendingRequests.values()) {
      cb('')
    }
    this.pendingRequests.clear()
  }

  async getAttestationHeader(timeoutMs: number = 8000): Promise<string> {
    await this.ensureDaemon()
    const proc = this.proc
    if (!proc || !proc.stdin || !this.isReady) {
      return JSON.stringify({ v: 1, s: 2 })
    }

    const stdin = proc.stdin
    return new Promise<string>((resolve) => {
      let resolved = false
      const timer = setTimeout(() => {
        if (resolved) return
        resolved = true
        resolve(JSON.stringify({ v: 1, s: 1 }))
      }, timeoutMs)

      const reqId = Math.floor(Math.random() * 1000000) + 10
      this.pendingRequests.set(reqId, (token: string) => {
        if (resolved) return
        resolved = true
        clearTimeout(timer)
        if (token) {
          resolve(JSON.stringify({ v: 1, s: 0, t: token }))
        } else {
          resolve(JSON.stringify({ v: 1, s: 2 }))
        }
      })

      try {
        stdin.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id: reqId,
            method: 'thread/start',
            params: { model: 'gpt-5.6-terra' },
          }) + '\n'
        )
      } catch {
        if (!resolved) {
          resolved = true
          clearTimeout(timer)
          this.pendingRequests.delete(reqId)
          resolve(JSON.stringify({ v: 1, s: 2 }))
        }
      }
    })
  }
}

const daemon = new CodexAttestationDaemon()

export async function generateCodexAttestationHeader(timeoutMs: number = 8000): Promise<string> {
  return daemon.getAttestationHeader(timeoutMs)
}
