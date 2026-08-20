// Un database MaxMind minimo, scritto a mano, SOLO per i test.
//
// PERCHE' ESISTE. Il file vero di DB-IP pesa ~8 MB e si scarica da internet:
// non entra in un repository e non puo' entrare in una suite, che deve girare
// senza rete. Senza un file valido pero' il lettore di `src/geo/reader.ts`
// resterebbe scritto e non verificato — e le cose che deve garantire (non
// lanciare mai, riconoscere un file sbagliato, tirare fuori il codice paese)
// sono esattamente quelle che si scoprono rotte in produzione.
//
// Questo NON e' un finto: e' un file nel formato MaxMind DB 2.0 che `mmdb-lib`
// apre davvero, con il suo albero binario, la sua sezione dati e i suoi
// metadati. Il codice sotto test non sa che e' piccolo.
//
// Il formato, per chi legge:
//
//   [albero di ricerca][16 byte a zero][sezione dati][marcatore][metadati]
//
// Ogni nodo dell'albero ha due record (bit 0 a sinistra, bit 1 a destra) da
// `record_size` bit. Il valore di un record significa tre cose diverse a
// seconda di quanto vale: minore di `node_count` e' un altro nodo; uguale a
// `node_count` e' «non trovato»; maggiore e' un puntatore alla sezione dati,
// all'offset `valore - node_count - 16`.

/** Un blocco di indirizzi e il paese che gli si attribuisce. */
export type MmdbEntry = {
  /** CIDR IPv4, per esempio `8.8.8.0/24`. */
  network: string;
  country: string;
  /**
   * Mette il codice sotto `registered_country` invece che `country`.
   *
   * Serve a un caso solo, e non e' teorico: il database vero ha righe in cui
   * `country` manca e c'e' solo il paese di registrazione. Se il lettore non
   * ricadesse su quello, quei giocatori diventerebbero `XX` per sempre.
   */
  registeredOnly?: boolean;
};

// --- codifica dei tipi MaxMind ---------------------------------------------

const TYPE_STRING = 2;
const TYPE_UINT16 = 5;
const TYPE_UINT32 = 6;
const TYPE_MAP = 7;
const TYPE_UINT64 = 9;
const TYPE_ARRAY = 11;

/**
 * Il byte (o i byte) di controllo.
 *
 * I tipi oltre il 7 non entrano nei tre bit alti: si scrive zero li' dentro e
 * il tipo vero va nel byte seguente, meno sette. Le dimensioni qui restano
 * sempre sotto 29, quindi il ramo esteso della lunghezza non serve.
 */
function control(type: number, size: number): Buffer {
  // L'ordine e' quello del formato e non e' intuitivo: byte di controllo,
  // POI il tipo esteso, POI i byte della dimensione.
  const small = size < 29;
  const sizeBits = small ? size : size < 285 ? 29 : 30;
  const head = type <= 7 ? [(type << 5) | sizeBits] : [sizeBits, type - 7];

  if (small) return Buffer.from(head);
  if (size < 285) return Buffer.from([...head, size - 29]);
  const rest = size - 285;
  if (rest > 0xffff) throw new Error(`fixture mmdb: dimensione ${size} fuori portata per questo scrittore`);
  return Buffer.from([...head, (rest >> 8) & 0xff, rest & 0xff]);
}

function encString(s: string): Buffer {
  const body = Buffer.from(s, 'utf8');
  return Buffer.concat([control(TYPE_STRING, body.length), body]);
}

/** Interi in big-endian MINIMALE: la dimensione e' il numero di byte usati. */
function encUint(type: number, value: number, maxBytes: number): Buffer {
  const full = Buffer.alloc(8);
  full.writeBigUInt64BE(BigInt(value));
  let start = 8 - maxBytes;
  while (start < 8 && full[start] === 0) start += 1;
  const body = full.subarray(start);
  return Buffer.concat([control(type, body.length), body]);
}

const encUint16 = (v: number) => encUint(TYPE_UINT16, v, 2);
const encUint32 = (v: number) => encUint(TYPE_UINT32, v, 4);
const encUint64 = (v: number) => encUint(TYPE_UINT64, v, 8);

function encMap(entries: Array<[string, Buffer]>): Buffer {
  return Buffer.concat([
    control(TYPE_MAP, entries.length),
    ...entries.flatMap(([k, v]) => [encString(k), v]),
  ]);
}

function encArray(items: Buffer[]): Buffer {
  return Buffer.concat([control(TYPE_ARRAY, items.length), ...items]);
}

// --- albero ----------------------------------------------------------------

/** Sentinella: «qui non c'e' niente». Diventa `node_count` in scrittura. */
const EMPTY = -1;

type Node = [number, number];

function parseCidr(network: string): { bytes: number[]; prefix: number } {
  const [addr, len] = network.split('/');
  if (!addr || !len) throw new Error(`fixture mmdb: CIDR non valido ${network}`);
  const bytes = addr.split('.').map((p) => Number(p));
  if (bytes.length !== 4 || bytes.some((b) => !Number.isInteger(b) || b < 0 || b > 255)) {
    throw new Error(`fixture mmdb: solo IPv4 in questo scrittore, ricevuto ${network}`);
  }
  return { bytes, prefix: Number(len) };
}

function bitAt(bytes: number[], index: number): 0 | 1 {
  const byte = bytes[index >> 3] ?? 0;
  return ((byte >> (7 - (index % 8))) & 1) as 0 | 1;
}

export type MmdbOptions = {
  databaseType?: string;
  /** Secondi epoch. Il lettore ci calcola l'eta' del database. */
  buildEpoch?: number;
};

export function buildCountryMmdb(entries: MmdbEntry[], opts: MmdbOptions = {}): Buffer {
  // 1. La sezione dati: un record per combinazione paese/collocazione.
  const dataChunks: Buffer[] = [];
  const dataOffsets = new Map<string, number>();
  let dataLength = 0;

  const recordFor = (country: string, registeredOnly: boolean): number => {
    const key = `${registeredOnly ? 'reg' : 'cc'}:${country}`;
    const known = dataOffsets.get(key);
    if (known !== undefined) return known;
    const inner = encMap([['iso_code', encString(country)]]);
    const record = encMap([[registeredOnly ? 'registered_country' : 'country', inner]]);
    dataOffsets.set(key, dataLength);
    dataChunks.push(record);
    const offset = dataLength;
    dataLength += record.length;
    return offset;
  };

  // 2. L'albero. Il nodo zero e' la radice e c'e' sempre, anche senza righe.
  const nodes: Node[] = [[EMPTY, EMPTY]];
  /** Offset nella sezione dati, tenuti a parte finche' non si sa `node_count`. */
  const dataRecords = new Map<string, number>();

  for (const entry of entries) {
    const { bytes, prefix } = parseCidr(entry.network);
    const offset = recordFor(entry.country, entry.registeredOnly === true);

    let current = 0;
    for (let depth = 0; depth < prefix; depth += 1) {
      const bit = bitAt(bytes, depth);
      const node = nodes[current] as Node;
      const last = depth === prefix - 1;

      if (last) {
        // L'ultimo bit porta al DATO, non a un altro nodo.
        dataRecords.set(`${current}:${bit}`, offset);
        node[bit] = EMPTY; // il valore vero si scrive dopo, serve node_count
        continue;
      }

      let next: number = node[bit];
      if (next === EMPTY || dataRecords.has(`${current}:${bit}`)) {
        next = nodes.length;
        nodes.push([EMPTY, EMPTY]);
        node[bit] = next;
      }
      current = next;
    }
  }

  const nodeCount = nodes.length;
  const recordValue = (nodeIndex: number, side: 0 | 1): number => {
    const data = dataRecords.get(`${nodeIndex}:${side}`);
    // `+ 16` perche' fra albero e dati c'e' il separatore, e il lettore lo
    // sottrae: e' la formula del formato, non un margine di sicurezza.
    if (data !== undefined) return data + 16 + nodeCount;
    const value = (nodes[nodeIndex] as Node)[side];
    return value === EMPTY ? nodeCount : value;
  };

  // 3. Serializzazione dell'albero: record da 32 bit, quindi otto byte a nodo.
  const tree = Buffer.alloc(nodeCount * 8);
  for (let i = 0; i < nodeCount; i += 1) {
    tree.writeUInt32BE(recordValue(i, 0), i * 8);
    tree.writeUInt32BE(recordValue(i, 1), i * 8 + 4);
  }

  const metadata = encMap([
    ['node_count', encUint32(nodeCount)],
    ['record_size', encUint16(32)],
    ['ip_version', encUint16(4)],
    ['database_type', encString(opts.databaseType ?? 'DBIP-Country-Lite')],
    ['languages', encArray([encString('en')])],
    ['binary_format_major_version', encUint16(2)],
    ['binary_format_minor_version', encUint16(0)],
    ['build_epoch', encUint64(opts.buildEpoch ?? Math.floor(Date.UTC(2026, 7, 1) / 1000))],
    ['description', encMap([['en', encString('fixture di test, non un database vero')]])],
  ]);

  return Buffer.concat([
    tree,
    Buffer.alloc(16),
    ...dataChunks,
    Buffer.from('ABCDEF4D61784D696E642E636F6D', 'hex'),
    metadata,
  ]);
}
