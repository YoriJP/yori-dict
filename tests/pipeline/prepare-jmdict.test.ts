import { gzipSync } from 'zlib'
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { parseArgs, prepareJmdict } from '../../scripts/pipeline/prepare-jmdict'

const tempDirs: string[] = []
const fixtureXml = `<?xml version="1.0" encoding="UTF-8"?>
<JMdict>
  <entry>
    <ent_seq>1358280</ent_seq>
    <r_ele><reb>たべる</reb></r_ele>
  </entry>
</JMdict>
`

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'yori-prepare-jmdict-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  }
})

describe('prepare JMdict source', () => {
  test('parses CLI arguments', () => {
    expect(parseArgs([
      '--file', 'JMdict_e.gz',
      '--out', 'data/sources/jmdict.xml',
      '--overwrite',
    ])).toEqual({
      file: 'JMdict_e.gz',
      url: 'http://ftp.edrdg.org/pub/Nihongo/JMdict_e.gz',
      out: 'data/sources/jmdict.xml',
      overwrite: true,
    })
  })

  test('copies local XML into the output path', async () => {
    const dir = makeTempDir()
    const inputPath = join(dir, 'JMdict_e.xml')
    const outPath = join(dir, 'prepared', 'JMdict_e.xml')
    await Bun.write(inputPath, fixtureXml)

    await prepareJmdict({
      file: inputPath,
      url: 'unused',
      out: outPath,
      overwrite: false,
    })

    expect(await Bun.file(outPath).text()).toBe(fixtureXml)
  })

  test('decompresses local gzipped XML', async () => {
    const dir = makeTempDir()
    const inputPath = join(dir, 'JMdict_e.gz')
    const outPath = join(dir, 'JMdict_e.xml')
    await Bun.write(inputPath, gzipSync(fixtureXml))

    await prepareJmdict({
      file: inputPath,
      url: 'unused',
      out: outPath,
      overwrite: false,
    })

    expect(await Bun.file(outPath).text()).toBe(fixtureXml)
  })

  test('refuses to overwrite existing output without the flag', async () => {
    const dir = makeTempDir()
    const inputPath = join(dir, 'JMdict_e.xml')
    const outPath = join(dir, 'prepared.xml')
    await Bun.write(inputPath, fixtureXml)
    await Bun.write(outPath, fixtureXml)

    await expect(prepareJmdict({
      file: inputPath,
      url: 'unused',
      out: outPath,
      overwrite: false,
    })).rejects.toThrow('Use --overwrite')
  })

  test('rejects non-JMdict XML input', async () => {
    const dir = makeTempDir()
    const inputPath = join(dir, 'bad.xml')
    const outPath = join(dir, 'JMdict_e.xml')
    await Bun.write(inputPath, '<not-jmdict />')

    await expect(prepareJmdict({
      file: inputPath,
      url: 'unused',
      out: outPath,
      overwrite: false,
    })).rejects.toThrow('does not look like JMdict XML')
  })
})
