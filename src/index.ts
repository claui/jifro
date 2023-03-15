import JSONStore from './json-store';
import { Predicate } from './query';
import {
  logger,
  z85DecodeAsUInt,
  z85DecodeAsDouble,
} from './utils';

class Index {
  protected store: JSONStore<string>;
  protected maxHeight = 32;
  protected logger = logger('index');

  constructor(public filename: string) {
    this.store = new JSONStore(filename);
  }

  async open() {
    await this.store.open();
  }

  async close() {
    await this.store.close();
  }

  get isOpen() {
    return this.store.isOpen;
  }

  async getFields() {
    let head = await this.getRootEntry();

    const fields: IndexFieldInfo[] = [];

    while (head.link) {
      head = await this.getEntry(head.link);
      const info: IndexFieldInfo = JSON.parse(head.node.value as string);
      fields.push(info);
    }

    return fields;
  }

  protected async getHead(
    field: string, cache?: IndexCache
  ) {
    let head = await this.getRootEntry();

    let name = '';

    while (name != field && head.link) {
      head = await this.getEntry(head.link, cache);
      name = (JSON.parse(head.node.value as string) as IndexFieldInfo).name;
      if (name == field) {
        head = await this.getEntry(head.position, cache, true);
      }
    }

    if (name != field)
      throw new IndexError(`Field "${field}" missing from index`);

    return head;
  }

  protected async getRootEntry() {
    const { start, value } = await this.store.get(1);
    const entry = new IndexEntry(value);
    entry.position = start;
    return entry;
  }

  protected async getEntry(
    position: number, cache?: IndexCache, update = false
  ) {
    const cached = cache && !update ? cache.get(position) : undefined;
    if (cached)
      return cached;
    const { start, value } = await this.store.get(position);
    const entry = new IndexEntry(value);
    entry.position = start;
    if (cache)
      cache.set(entry.position, entry);
    return entry;
  }

  async find(field: string, predicate: Predicate<SkipListValue>) {
    const cache: IndexCache = new Map();

    const head = await this.getHead(field, cache);
    const height = head.node.levels.filter(p => p != 0).length;

    const info: IndexFieldInfo = JSON.parse(head.node.value as string);

    if (info.tx)
      throw new IndexError(`Field "${field}" in transaction`);

    if (info.type == 'date-time')
      predicate.key = Date.parse as (s: SkipListValue) => number;

    let found = false;

    let current: IndexEntry | null = head;
    for (let i = height - 1; i >= 0; i--) {
      let nextNodePos: number;
      while (nextNodePos = current.node.next(i)) {
        const next = await this.getEntry(nextNodePos, cache);
        const { seek } = predicate(next.node.value);
        if (seek <= 0)
          current = next;
        if (seek == 0)
          found = true;
        if (seek >= 0)
          break;
      }
      if (found)
        break;
    }

    if (current == head)
      current = current.node.next(0) ?
        await this.getEntry(current.node.next(0), cache) : null;

    const pointers = new Set<number>();

    while (current) {
      let entry = current;
      current = current.node.next(0) ?
        await this.getEntry(current.node.next(0), cache) : null;
      const { seek, match } = predicate(entry.node.value);
      if (seek <= 0 && !match)
        continue;
      if (!match)
        break;
      pointers.add(entry.pointer);
      while (entry.link) {
        const link = await this.getEntry(entry.link, cache);
        pointers.add(link.pointer);
        entry = link;
      }
    }

    return pointers;
  }
}

export class IndexError extends Error { }
IndexError.prototype.name = 'IndexError';

const enum SkipListValueType {
  Null,
  Boolean,
  Number,
  String
}

type SkipListValue = null | boolean | number | string;

class SkipListNode {
  public levels: number[] = [];
  public value: SkipListValue = null;

  get type() {
    return typeof this.value == 'boolean' ? SkipListValueType.Boolean :
      typeof this.value == 'number' ? SkipListValueType.Number :
        typeof this.value == 'string' ? SkipListValueType.String :
          SkipListValueType.Null;
  }

  constructor(encodedNode: string);
  constructor(levels: number[], value?: SkipListValue);
  constructor(obj: any, value?: SkipListValue) {
    if (Array.isArray(obj)) {
      const levels: number[] = obj;
      if (!levels)
        throw new TypeError('levels is required');
      if (typeof value == 'number' && !Number.isFinite(value))
        throw new TypeError('Number value must be finite');
      this.value = value == null ? null : value;
      this.levels = levels;
    } else {
      const encodedNode = obj as string;
      if (!encodedNode)
        return;
      const parts = encodedNode.split(';');
      const [encodedLevels, encodedType] = parts.slice(0, 2);
      const type = z85DecodeAsUInt(encodedType, true);
      this.value = SkipListNode.decodeValue(type, parts.slice(2).join(';'));
      this.levels = encodedLevels ?
        encodedLevels.split(',').map(l => z85DecodeAsUInt(l)) : [];
    }
  }

  next(level: number) {
    return this.levels[level];
  }

  protected static decodeValue(type: SkipListValueType, value: string) {
    switch (type) {
      case SkipListValueType.Boolean:
        return Boolean(z85DecodeAsUInt(value, true));
      case SkipListValueType.Number:
        return z85DecodeAsDouble(value, true);
      case SkipListValueType.String:
        return value;
      default:
        return null;
    }
  }
}

class IndexEntry {
  position: number = 0;

  pointer: number; // Pointer to object in database
  link: number = 0; // Pointer to next duplicate in index
  node: SkipListNode;

  constructor(encodedEntry: string);
  constructor(pointer: number, node: SkipListNode);
  constructor(obj: any, node?: SkipListNode) {
    if (typeof obj == 'string') {
      const encodedEntry = obj as string;
      const encodedParts = encodedEntry.split(';');
      const encodedPointer = encodedParts[0];
      const encodedLink = encodedParts[1];
      const encodedNode = encodedParts.slice(2).join(';');
      this.pointer = z85DecodeAsUInt(encodedPointer);
      this.link = z85DecodeAsUInt(encodedLink);
      this.node = new SkipListNode(encodedNode);
    } else {
      if (obj == null || !node)
        throw new TypeError('pointer and node are required');
      this.pointer = obj;
      this.node = node;
    }
  }
}

export interface IndexFieldInfo extends IndexField {
  tx?: number;
}

export interface IndexField {
  name: string;
  type?: string;
}

export interface IndexCache {
  get(key: number | string): IndexEntry | undefined;
  set(key: number | string, value: IndexEntry): void;
}

export default Index;
