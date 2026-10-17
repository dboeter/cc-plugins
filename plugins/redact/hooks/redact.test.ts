import { test, expect } from 'claude-code/testing'
import { MARK, redact } from './redact'

// Fixtures are split so no literal matches scripts/git-hooks/lib/secret-content.ere,
// which the pre-push gate runs over every added line, and so the live plugin leaves this
// file readable (and so editable): split inside the name or keyword, as in
// 'DB_PASS' + 'WORD=…', never at the separator. Code-shaped negatives need no split.
const GH = 'ghp_' + 'a'.repeat(36)
const ANT = 'sk-ant-' + 'api03-' + 'abcdefghijklmnopqrstuv'
const KEY = 'PRIV' + 'ATE KEY-----'
const PEM = '-----BEGIN OPENSSH ' + KEY + '\nb3BlbnNzaC1rZXk\n-----END OPENSSH ' + KEY

test('redact masks values and keeps names', () => {
  expect(redact(`GITHUB_TOKEN=${GH}`)).toBe(`GITHUB_TOKEN=${MARK}`)
  expect(redact(`key ${ANT}`)).toBe(`key ${MARK}`)
  expect(redact(PEM)).toBe(MARK)
  expect(redact('Authorization: Bea' + 'rer abc.def')).toBe('Authorization: Bearer ' + MARK)
  expect(redact('https://me:hunt' + 'er2@host/x')).toBe('https://me:' + MARK + '@host/x')
  expect(redact('"api_' + 'key": "abc123"')).toBe(`"api_key": "${MARK}"`)
  expect(redact('DB_PASS' + 'WORD=hunter2 ok')).toBe(`DB_PASSWORD=${MARK} ok`)
  expect(redact('mysql --pass' + 'word hunter2')).toBe(`mysql --password ${MARK}`)
})

test('a key cut short is masked through its body, and no further', () => {
  const head = '-----BEGIN RSA ' + KEY
  expect(redact(`${head}\nMIIEowIBAAKCAQEA\nabc+/=`)).toBe(MARK)
  expect(redact(`${head}\nMIIEow\nsome prose`)).toBe(`${MARK}\nsome prose`)
  expect(redact(`"k": "${head}\\nMIIEow\\nabc`)).toBe(`"k": "${MARK}`)
  expect(redact(`${head} names the format`)).toBe(`${head} names the format`)
})

test('vendor token shapes are masked', () => {
  for (const t of [
    'sk_' + 'live_' + 'a'.repeat(24), 'gl' + 'pat-' + 'a'.repeat(20), 'hf' + '_' + 'a'.repeat(34),
    'np' + 'm_' + 'a'.repeat(36), 'dckr' + '_pat_' + 'a'.repeat(20), 'S' + 'G.' + 'a'.repeat(20) + '.' + 'b'.repeat(20),
    'ya' + '29.' + 'a'.repeat(20), 'AS' + 'IA' + 'A'.repeat(16),
  ]) expect(redact(`x ${t} y`)).toBe(`x ${MARK} y`)
})

test('a value is masked whole and nothing past it', () => {
  expect(redact('PASS' + 'WORD="two words" x')).toBe(`PASSWORD="${MARK}" x`)
  expect(redact('mysql --pass' + 'word=hunter2')).toBe(`mysql --password=${MARK}`)
  expect(redact('curl "h/?access_to' + 'ken=abc&next=1"')).toBe(`curl "h/?access_token=${MARK}&next=1"`)
  expect(redact('fn(to' + 'ken=abc), next')).toBe(`fn(token=${MARK}), next`)
  expect(redact('pass' + 'word: admin')).toBe(`password: ${MARK}`)
  expect(redact('to' + 'ken = abc123')).toBe(`token = ${MARK}`)
})

test('ordinary output and code that names a secret are left alone', () => {
  for (const s of [
    'max_tokens: 1000', 'use_token: true', 'git status: clean', 'total 42',
    'const token = await getToken();', '  password: string;', 'def f(password: str):',
    'tokens = text.split(" ")', "API_KEY = os.environ['API_KEY']", 'token = self.token',
    'f(token=token, x=1)', '  GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}', 'TOKEN="${GITHUB_TOKEN:-}"',
    'token = ""', 'Bearer $TOKEN', 'postgres://me:$PW@host',
  ]) expect(redact(s)).toBe(s)
})

test('Bash stdout is masked', async ($, on) => {
  on('tool.call', { tool: 'Bash' }, async () => ({ result: { stdout: `GITHUB_TOKEN=${GH}\n${PEM}`, stderr: '', interrupted: false } }))
  const r: any = await $.tool.call({ tool: 'Bash', command: 'env' })
  expect(r.result.stdout).toBe(`GITHUB_TOKEN=${MARK}\n${MARK}`)
  expect(JSON.stringify(r)).not.toContain('aaaa')
})

test('nested Read result is masked', async ($, on) => {
  on('tool.call', { tool: 'Read' }, async () => ({ result: { type: 'text', file: { filePath: '/x/.env', content: 'SECRET' + '_KEY=hunter2' } } } as any))
  const r: any = await $.tool.call({ tool: 'Read', file_path: '/x/.env' })
  expect(r.result.file.content).toBe(`SECRET_KEY=${MARK}`)
})

test('clean output comes back as the same object', async ($, on) => {
  const answer = { result: { stdout: 'hello', stderr: '', interrupted: false } }
  on('tool.call', { tool: 'Bash' }, async () => answer)
  const r = await $.tool.call({ tool: 'Bash', command: 'echo hello' })
  expect(r).toEqual(answer)
})

test('writing the mark back is denied, the plugin itself included', async ($, on) => {
  on('tool.call', { tool: 'Write' }, async () => ({ result: { type: 'create' } } as any))
  const denied: any = await $.tool.call({ tool: 'Write', file_path: '/repo/.env', content: `KEY=${MARK}` })
  expect(denied.deny).toContain('stand-in')
  const own: any = await $.tool.call({ tool: 'Write', file_path: '/d/claude/plugins/redact/hooks/x.ts', content: MARK })
  expect(own.deny).toContain('stand-in')
})

test('the mark as old text is denied: it cannot match the file', async ($, on) => {
  on('tool.call', { tool: 'Edit' }, async () => ({ result: {} } as any))
  const r: any = await $.tool.call({ tool: 'Edit', file_path: '/repo/a.ts', old_string: `x = ${MARK}`, new_string: 'x = 1' })
  expect(r.deny).toContain('stand-in')
})

test('quoting the mark to the person or in a description is not a write', async ($, on) => {
  on('tool.call', { tool: 'SendUserMessage' }, async () => ({ result: { message: 'ok' } } as any))
  on('tool.call', { tool: 'Bash' }, async () => ({ result: { stdout: '', stderr: '', interrupted: false } }))
  const msg: any = await $.tool.call({ tool: 'SendUserMessage', message: `GITHUB_TOKEN=${MARK}`, status: 'normal' } as any)
  expect(msg.deny).toBeUndefined()
  const bash: any = await $.tool.call({ tool: 'Bash', command: 'true', description: `explain ${MARK}` })
  expect(bash.deny).toBeUndefined()
})

test('an error result stays an error, masked', async ($, on) => {
  on('tool.call', { tool: 'Bash' }, async () => ({ isError: true, result: `fatal: GITHUB_TOKEN=${GH}`, text: `fatal: GITHUB_TOKEN=${GH}` } as any))
  const r: any = await $.tool.call({ tool: 'Bash', command: 'false' })
  expect(r.deny).toBe(`fatal: GITHUB_TOKEN=${MARK}`)
})

test('an error with no text is masked from its stored result', async ($, on) => {
  on('tool.call', { tool: 'Bash' }, async () => ({ isError: true, result: `fatal: ${GH}` } as any))
  const r: any = await $.tool.call({ tool: 'Bash', command: 'false' })
  expect(r.deny).toBe(`fatal: ${MARK}`)
})

test('output the hook fails to mask is withheld, not passed through', async ($, on) => {
  const stdout: any = { text: GH }
  stdout.self = stdout // walk recurses forever and throws
  on('tool.call', { tool: 'Bash' }, async () => ({ result: { stdout, stderr: '', interrupted: false } } as any))
  const r: any = await $.tool.call({ tool: 'Bash', command: 'env' })
  expect(r.deny).toContain('withheld')
  expect(JSON.stringify(r)).not.toContain('aaaa')
})

// Crafted shapes that took quadratic time before the repeats were bounded (seconds at these
// sizes, past the 10 s hook budget well before 1 MB). Sized so a regression fails here.
test('crafted output is masked in linear time', () => {
  const fill = (unit: string, n: number) => unit.repeat(Math.ceil(n / unit.length))
  for (const [s, what] of [
    [fill('to' + 'ken', 1e5), 'one word full of a secret name'],
    [fill('-ey' + 'Jabc', 2e5), 'JWT-like starts'],
    [fill('-----BEGIN RSA ' + KEY + '\nabc\n', 1e6), 'unterminated BEGIN lines'],
  ] as const) {
    const t = Date.now()
    redact(s)
    expect([what, Date.now() - t < 1000]).toEqual([what, true])
  }
})
