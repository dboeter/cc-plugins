import { test, expect } from 'claude-code/testing'
import { rmTargets } from './guard-context'

test('rm operands, flags dropped, quotes stripped', () => {
  expect(rmTargets('rm -rf build dist')).toEqual(['build', 'dist'])
  expect(rmTargets("rm -r -f 'my dir' \"x y\"")).toEqual(['my dir', 'x y'])
  expect(rmTargets('rm -rf -- -weird')).toEqual(['-weird'])
})

test('wrappers, paths and the first rm clause only', () => {
  expect(rmTargets('sudo /bin/rm -rf /opt/x')).toEqual(['/opt/x'])
  expect(rmTargets('FOO=1 \\rm -rf a')).toEqual(['a'])
  expect(rmTargets('cd x && rm -rf a; rm -rf b')).toEqual(['a'])
  expect(rmTargets('git rm -r a')).toEqual([])
})

test('a rm without -r has no targets: guard.sh does not ask on it', () => {
  expect(rmTargets('rm a b')).toEqual([])
  expect(rmTargets('rm --recursive a')).toEqual(['a'])
})
