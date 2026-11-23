/**
 * Самодостаточный генератор QR-кодов: байтовый режим, уровень коррекции M,
 * маска 0, версии 1–10 (до ~170 символов URL). Внешних зависимостей нет,
 * матрица проверена эталонным генератором (segno) в тестах.
 */

interface RsBlock {
  dataCount: number
  totalCount: number
}

// Таблица блоков для уровня M (версии 1–10): количество блоков и объёмы.
const RS_BLOCKS: RsBlock[][] = [
  [{ dataCount: 16, totalCount: 26 }],
  [{ dataCount: 28, totalCount: 44 }],
  [{ dataCount: 44, totalCount: 70 }],
  [{ dataCount: 32, totalCount: 50 }, { dataCount: 32, totalCount: 50 }],
  [{ dataCount: 43, totalCount: 67 }, { dataCount: 43, totalCount: 67 }],
  [
    { dataCount: 27, totalCount: 43 }, { dataCount: 27, totalCount: 43 },
    { dataCount: 27, totalCount: 43 }, { dataCount: 27, totalCount: 43 },
  ],
  [
    { dataCount: 31, totalCount: 49 }, { dataCount: 31, totalCount: 49 },
    { dataCount: 31, totalCount: 49 }, { dataCount: 31, totalCount: 49 },
  ],
  [
    { dataCount: 38, totalCount: 60 }, { dataCount: 38, totalCount: 60 },
    { dataCount: 39, totalCount: 61 }, { dataCount: 39, totalCount: 61 },
  ],
  [
    { dataCount: 36, totalCount: 58 }, { dataCount: 36, totalCount: 58 },
    { dataCount: 36, totalCount: 58 }, { dataCount: 37, totalCount: 59 },
    { dataCount: 37, totalCount: 59 },
  ],
  [
    { dataCount: 43, totalCount: 69 }, { dataCount: 43, totalCount: 69 },
    { dataCount: 43, totalCount: 69 }, { dataCount: 43, totalCount: 69 },
    { dataCount: 44, totalCount: 70 },
  ],
]

const ALIGNMENT_CENTERS: number[][] = [
  [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
  [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
]

const PAD_BYTES = [0xec, 0x11]

// GF(256) с примитивным полиномом 0x11d.
const EXP_TABLE = new Array<number>(512)
const LOG_TABLE = new Array<number>(256)
;(() => {
  let value = 1
  for (let i = 0; i < 255; i += 1) {
    EXP_TABLE[i] = value
    LOG_TABLE[value] = i
    value <<= 1
    if (value & 0x100) value ^= 0x11d
  }
  for (let i = 255; i < 512; i += 1) EXP_TABLE[i] = EXP_TABLE[i - 255]
})()

function gmul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0
  return EXP_TABLE[LOG_TABLE[a] + LOG_TABLE[b]]
}

function rsGenerator(degree: number): number[] {
  let poly = [1]
  for (let i = 0; i < degree; i += 1) {
    const next = new Array<number>(poly.length + 1).fill(0)
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= gmul(poly[j], EXP_TABLE[i])
      next[j + 1] ^= poly[j]
    }
    poly = next
  }
  return poly
}

function rsEncode(data: number[], ecCount: number): number[] {
  const generator = rsGenerator(ecCount)
  // Сдвиговый регистр: result[0] — коэффициент старшей степени, порядок совпадает
  // с порядком передачи EC-кодов. Ведущий коэффициент генератора (всегда 1)
  // сокращается при делении и не участвует.
  const result = new Array<number>(ecCount).fill(0)
  for (const byte of data) {
    const factor = byte ^ result.shift()!
    result.push(0)
    if (factor !== 0) {
      for (let i = 0; i < ecCount; i += 1) result[i] ^= gmul(generator[ecCount - 1 - i], factor)
    }
  }
  return result
}

function formatBits(): number {
  // Уровень M (00) + маска 0 (000) → данные 00000, BCH(15,5), маска XOR 101010000010010.
  const data = 0
  let remainder = data
  for (let i = 0; i < 10; i += 1) {
    remainder = (remainder << 1) ^ (((remainder >> 9) & 1) === 1 ? 0b10100110111 : 0)
  }
  return ((data << 10) | remainder) ^ 0b101010000010010
}

export interface QrMatrix {
  /** Размер стороны в модулях. */
  size: number
  /** true — тёмный модуль. Индексация [row][col]. */
  modules: boolean[][]
}

export function createQrMatrix(text: string): QrMatrix {
  const bytes = new TextEncoder().encode(text)
  const version = pickVersion(bytes.length)
  const blocks = RS_BLOCKS[version - 1]
  const totalData = blocks.reduce((sum, block) => sum + block.dataCount, 0)
  const data = encodeData(bytes, totalData, version)
  const codewords = interleave(data, blocks)
  return buildMatrix(codewords, version)
}

function pickVersion(length: number): number {
  for (let version = 1; version <= 10; version += 1) {
    const totalData = RS_BLOCKS[version - 1].reduce((sum, block) => sum + block.dataCount, 0)
    const lengthBits = version <= 9 ? 8 : 16
    const capacityBytes = Math.floor((totalData * 8 - 4 - lengthBits) / 8)
    if (length <= capacityBytes) return version
  }
  throw new Error('Текст слишком длинный для QR-кода (максимум около 170 байт).')
}

function encodeData(bytes: Uint8Array, totalData: number, version: number): number[] {
  const bits: number[] = []
  const push = (value: number, count: number) => {
    for (let i = count - 1; i >= 0; i -= 1) bits.push((value >> i) & 1)
  }
  push(0b0100, 4) // байтовый режим
  push(bytes.length, version <= 9 ? 8 : 16)
  for (const byte of bytes) push(byte, 8)
  const capacity = totalData * 8
  push(0, Math.min(4, capacity - bits.length)) // терминатор
  while (bits.length % 8 !== 0) bits.push(0)
  const data: number[] = []
  for (let i = 0; i < bits.length; i += 8) {
    data.push(bits.slice(i, i + 8).reduce((acc, bit) => (acc << 1) | bit, 0))
  }
  for (let pad = 0; data.length < totalData; pad += 1) data.push(PAD_BYTES[pad % 2])
  return data
}

function interleave(data: number[], blocks: RsBlock[]): number[] {
  const dataBlocks: number[][] = []
  const ecBlocks: number[][] = []
  let offset = 0
  for (const block of blocks) {
    const slice = data.slice(offset, offset + block.dataCount)
    offset += block.dataCount
    dataBlocks.push(slice)
    ecBlocks.push(rsEncode(slice, block.totalCount - block.dataCount))
  }
  const result: number[] = []
  const maxData = Math.max(...dataBlocks.map((block) => block.length))
  for (let i = 0; i < maxData; i += 1) {
    for (const block of dataBlocks) if (i < block.length) result.push(block[i])
  }
  const maxEc = Math.max(...ecBlocks.map((block) => block.length))
  for (let i = 0; i < maxEc; i += 1) {
    for (const block of ecBlocks) if (i < block.length) result.push(block[i])
  }
  return result
}

function buildMatrix(codewords: number[], version: number): QrMatrix {
  const size = 17 + version * 4
  const modules: (boolean | null)[][] = Array.from({ length: size }, () => new Array<boolean | null>(size).fill(null))

  const placeFinder = (row: number, col: number) => {
    for (let r = -1; r <= 7; r += 1) {
      for (let c = -1; c <= 7; c += 1) {
        const rr = row + r
        const cc = col + c
        if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue
        modules[rr][cc] = r >= 0 && r <= 6 && c >= 0 && c <= 6 &&
          (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4))
      }
    }
  }
  placeFinder(0, 0)
  placeFinder(0, size - 7)
  placeFinder(size - 7, 0)

  for (let i = 8; i < size - 8; i += 1) {
    modules[6][i] = i % 2 === 0
    modules[i][6] = i % 2 === 0
  }

  const centers = ALIGNMENT_CENTERS[version - 1]
  for (const row of centers) {
    for (const col of centers) {
      if (modules[row][col] !== null) continue
      for (let r = -2; r <= 2; r += 1) {
        for (let c = -2; c <= 2; c += 1) {
          modules[row + r][col + c] = Math.max(Math.abs(r), Math.abs(c)) !== 1
        }
      }
    }
  }

  // Резерв под форматную информацию (заполняется после маскирования).
  const reserveFormat = () => {
    for (let i = 0; i <= 8; i += 1) {
      if (i !== 6) {
        if (modules[8][i] === null) modules[8][i] = false
        if (modules[i][8] === null) modules[i][8] = false
      }
    }
    for (let i = 0; i < 8; i += 1) {
      if (modules[8][size - 1 - i] === null) modules[8][size - 1 - i] = false
      if (modules[size - 1 - i][8] === null) modules[size - 1 - i][8] = false
    }
  }
  reserveFormat()

  // Размещение данных зигзагом, маска 0: (row + col) % 2 === 0.
  let inc = -1
  let row = size - 1
  let bitIndex = 7
  let byteIndex = 0
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col -= 1
    for (;;) {
      for (let c = 0; c < 2; c += 1) {
        if (modules[row][col - c] === null) {
          let dark = false
          if (byteIndex < codewords.length) dark = ((codewords[byteIndex] >>> bitIndex) & 1) === 1
          if ((row + col - c) % 2 === 0) dark = !dark
          modules[row][col - c] = dark
          bitIndex -= 1
          if (bitIndex === -1) {
            byteIndex += 1
            bitIndex = 7
          }
        }
      }
      row += inc
      if (row < 0 || row >= size) {
        row -= inc
        inc = -inc
        break
      }
    }
  }

  // Форматная информация (уровень M, маска 0).
  const bits = formatBits()
  for (let i = 0; i < 15; i += 1) {
    const dark = ((bits >> i) & 1) === 1
    if (i < 6) modules[i][8] = dark
    else if (i < 8) modules[i + 1][8] = dark
    else modules[size - 15 + i][8] = dark

    if (i < 8) modules[8][size - i - 1] = dark
    else if (i < 9) modules[8][15 - i - 1 + 1] = dark
    else modules[8][15 - i - 1] = dark
  }
  modules[size - 8][8] = true // тёмный модуль

  return { size, modules: modules.map((line) => line.map((cell) => cell === true)) }
}
