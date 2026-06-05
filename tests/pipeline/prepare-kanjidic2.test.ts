import { gzipSync } from 'zlib'
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { parseArgs, prepareKanjidic2 } from '../../scripts/pipeline/prepare-kanjidic2'

const tempDirs: string[] = []
const fixtureXml = `<?xml version="1.0" encoding="UTF-8"?>
<kanjidic2>
  <character>
    <literal>食</literal>
  </character>
</kanjidic2>
`

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'yori-prepare-kanjidic2-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  }
})

describe('prepare KANJIDIC2 source', () => {
  test('parses CLI arguments', () => {
    expect(parseArgs([
      '--file', 'kanjidic2.xml.gz',
      '--out', 'data/sources/kanjidic2.xml',
      '--overwrite',
    ])).toEqual({
      file: 'kanjidic2.xml.gz',
      url: 'https://www.edrdg.org/kanjidic/kanjidic2.xml.gz',
      out: 'data/sources/kanjidic2.xml',
      overwrite: true,
    })
  })

  test('copies local XML into the output path', async () => {
    const dir = makeTempDir()
    const inputPath = join(dir, 'kanjidic2.xml')
    const outPath = join(dir, 'prepared', 'kanjidic2.xml')
    await Bun.write(inputPath, fixtureXml)

    await prepareKanjidic2({
      file: inputPath,
      url: 'unused',
      out: outPath,
      overwrite: false,
    })

    expect(await Bun.file(outPath).text()).toBe(fixtureXml)
  })

  test('decompresses local gzipped XML', async () => {
    const dir = makeTempDir()
    const inputPath = join(dir, 'kanjidic2.xml.gz')
    const outPath = join(dir, 'kanjidic2.xml')
    await Bun.write(inputPath, gzipSync(fixtureXml))

    await prepareKanjidic2({
      file: inputPath,
      url: 'unused',
      out: outPath,
      overwrite: false,
    })

    expect(await Bun.file(outPath).text()).toBe(fixtureXml)
  })

  test('refuses to overwrite existing output without the flag', async () => {
    const dir = makeTempDir()
    const inputPath = join(dir, 'kanjidic2.xml')
    const outPath = join(dir, 'prepared.xml')
    await Bun.write(inputPath, fixtureXml)
    await Bun.write(outPath, fixtureXml)

    await expect(prepareKanjidic2({
      file: inputPath,
      url: 'unused',
      out: outPath,
      overwrite: false,
    })).rejects.toThrow('Use --overwrite')
  })

  test('rejects non-KANJIDIC2 XML input', async () => {
    const dir = makeTempDir()
    const inputPath = join(dir, 'bad.xml')
    const outPath = join(dir, 'kanjidic2.xml')
    await Bun.write(inputPath, '<not-kanjidic />')

    await expect(prepareKanjidic2({
      file: inputPath,
      url: 'unused',
      out: outPath,
      overwrite: false,
    })).rejects.toThrow('does not look like kanjidic2 XML')
  })
})
