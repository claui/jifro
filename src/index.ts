import JSONStore from './json-store';
import { Predicate } from './query';
import {
  z85DecodeAsUInt32, z85EncodeAsUInt32,
  z85DecodeAsDouble, z85EncodeAsDouble
} from './utils';

class Index {
  protected store: JSONStore<SerializedIndexEntry>;
  protected maxHeight = 32;

  constructor(filename: string) {
    this.store = new JSONStore(filename, 0);
  }

  async create(fields: string[]) {
    await this.store.create();
    await this.insertHeads(fields);
  }

  async drop() {
    await this.store.destroy();
  }

  async find(field: string, predicate: Predicate<SkipListValue>) {
    const entries = await this.findEntries(field, predicate);
    return entries.map(entry => entry.pointer);
  }

  async insert(objectFields: ObjectField | ObjectField[]) {
    if (!Array.isArray(objectFields))
      objectFields = [objectFields];

    const alreadyOpen = this.store.isOpen;
    if (!alreadyOpen)
      await this.store.open();

    const headPosCache: { [field: string]: number } = {};
    const cache: IndexCache = new Map();

    const updates = new Set<number>();

    let position = -1;
    for (const objectField of objectFields) {
      const cachedHeadPos = headPosCache[objectField.field];
      let head: IndexEntry;
      if (cachedHeadPos)
        head = cache.get(cachedHeadPos)!;
      else {
        head = this.getHead(objectField.field, cache);
        headPosCache[objectField.field] = head.position;
      }
      const positions = this.indexObjectField(
        objectField, head!, position, cache
      );
      for (const position of positions)
        updates.add(position);
      --position;
    }

    let startPosition = 0;
    let insertPosition: number | undefined;
    const output: string[] = [];

    const insert = async (entry: IndexEntry) => {
      const stack = [entry];
      while (stack.length) {
        const entry = stack.pop()!;
        if (entry.position >= 0)
          continue;

        let pending = false;
        for (let i = 0; i < entry.node.levels.length; i++) {
          const pos = entry.node.levels[i];
          if (pos >= 0)
            continue;
          const next = cache.get(pos)!;
          entry.node.levels[i] = next.position;
          if (pos != next.position)
            continue;
          if (!pending)
            stack.push(entry);
          stack.push(next);
          pending = true;
        }

        if (entry.link < 0) {
          const next = cache.get(entry.link)!;
          const link = next.position;
          if (entry.link == link) {
            stack.push(entry);
            stack.push(next);
            pending = true;
          }
          entry.link = link;
        }

        if (!pending) {
          updates.delete(entry.position);
          if (insertPosition) {
            const raw = this.store.stringify(entry.serialized());
            const start = insertPosition + 1;
            const length = raw.length;
            insertPosition = start + length + 1;
            entry.position = start;
            if (cache)
              cache.set(entry.position, entry);
            output.push(raw);
          } else {
            insertPosition = await this.insertEntry(entry, cache);
          }
          if (!startPosition)
            startPosition = insertPosition;
        }
      }
    };

    for (let i = -1; i > position; i--)
      await insert(cache.get(i)!);
    await this.store.appendRaw(
      this.store.joinForAppend(output), startPosition
    );

    for (const pos of updates) {
      const entry = cache.get(pos)!;
      for (let i = 0; i < entry.node.levels.length; i++) {
        const p = entry.node.levels[i];
        if (p < 0)
          entry.node.levels[i] = cache.get(p)!.position;
      }
      if (entry.link < 0)
        entry.link = cache.get(entry.link)!.position;
      await this.updateEntry(entry);
    }

    if (!alreadyOpen)
      await this.store.close();
  }

  protected indexObjectField(
    objectField: ObjectField, head: IndexEntry, entryPosition: number,
    cache?: IndexCache,
  ) {
    const { field, value, position } = objectField;

    cache = cache || new Map();

    let height = head.node.levels.filter(p => p != 0).length;

    const maxLevel = Math.min(height, this.maxHeight - 1);

    let level = 0;
    while (level < maxLevel && Math.round(Math.random()))
      ++level;

    height = Math.max(height, level + 1);

    const updates: IndexEntry[] = [];

    let current = head;

    for (let i = height - 1; i >= 0; i--) {
      let nextNodePos: number;
      while (nextNodePos = current.node.next(i)) {
        const next = this.getEntry(nextNodePos, cache);
        if (next.node.value! <= value)
          current = next;
        if (next.node.value! >= value)
          break;
      }

      if (i > level)
        continue;

      updates.push(current);
    }

    const prev = updates[updates.length - 1];
    const isDuplicate = prev.node.value == value;

    const entry = isDuplicate ?
      new IndexEntry(field, position, new SkipListNode([])) :
      new IndexEntry(field, position,
        new SkipListNode(Array(level + 1).fill(0), value)
      );

    entry.position = entryPosition; // placeholder position
    cache.set(entry.position, entry);

    if (isDuplicate) {
      entry.link = prev.link;
      prev.link = entry.position;
      return new Set([prev.position]);
    }

    const positions = new Set<number>();

    for (let i = 0; i <= level; i++) {
      const current = updates[updates.length - i - 1];
      entry.node.levels[i] = current.node.next(i);
      current.node.levels[i] = entry.position;
      positions.add(current.position);
    }

    return positions;
  }

  protected async insertHeads(fields: string[]) {
    const alreadyOpen = this.store.isOpen;
    if (!alreadyOpen)
      await this.store.open();

    let head: IndexEntry;
    try {
      head = this.getRootEntry();
    } catch (e) {
      head = await this.insertRootEntry();
    }

    while (head.link) {
      head = this.getEntry(head.link);
      fields = fields.filter(f => f != head.field);
    }

    let position;
    for (const field of fields) {
      const prevHead = head;
      head = new IndexEntry(
        field, 0, new SkipListNode(Array(this.maxHeight).fill(0))
      );
      position = await this.insertEntry(head, undefined, position);
      prevHead.link = head.position;
      await this.updateEntry(prevHead);
    }

    if (!alreadyOpen)
      await this.store.close();
  }

  protected getHead(field: string, cache?: IndexCache) {
    let head = this.getRootEntry(cache);

    while (head.field != field && head.link)
      head = this.getEntry(head.link, cache);

    if (head.field != field)
      throw new Error(`Field "${field}" missing from index`);

    return head;
  }

  protected getRootEntry(cache?: IndexCache) {
    const cached = cache && cache.get(0);
    if (cached)
      return cached;
    const { start, value } = this.store.getSync(1);
    const entry = new IndexEntry(value);
    entry.position = start;
    if (cache)
      cache.set(0, entry);
    return entry;
  }

  protected async insertRootEntry(cache?: IndexCache) {
    const entry = new IndexEntry("", 0, new SkipListNode([]));
    await this.insertEntry(entry);
    if (cache)
      cache.set(0, entry);
    return entry;
  }

  protected async insertEntry(
    entry: IndexEntry, cache?: IndexCache, position?: number
  ) {
    const { start, length } = await this.store.insert(
      entry.serialized(), position, true
    );
    entry.position = start;
    if (cache)
      cache.set(entry.position, entry);
    return start + length + 1;
  }

  protected getEntry(position: number, cache?: IndexCache) {
    const cached = cache && cache.get(position);
    if (cached)
      return cached;
    const { start, value } = this.store.getSync(position);
    const entry = new IndexEntry(value);
    entry.position = start;
    if (cache)
      cache.set(entry.position, entry);
    return entry;
  }

  protected async updateEntry(entry: IndexEntry) {
    // offset 4 = 1 brace + 2 quotes + 1 colon
    await this.store.set(
      entry.position + 4 + entry.field.length, entry.encoded()
    );
  }

  protected async findEntries(field: string, predicate: Predicate<SkipListValue>) {
    const alreadyOpen = this.store.isOpen;
    if (!alreadyOpen)
      await this.store.open();

    const cache: IndexCache = new Map();

    const head = this.getHead(field, cache);
    const height = head.node.levels.filter(p => p != 0).length;

    let found = false;

    let current: IndexEntry | null = head;
    for (let i = height; i >= 0; i--) {
      while (current.node.next(i)) {
        const next = this.getEntry(current.node.next(i), cache);
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
        this.getEntry(current.node.next(0), cache) : null;

    const entries: IndexEntry[] = [];

    while (current) {
      let entry = current;
      current = current.node.next(0) ?
        this.getEntry(current.node.next(0), cache) : null;
      const { seek, match } = predicate(entry.node.value);
      if (seek <= 0 && !match)
        continue;
      if (!match)
        break;
      entries.push(entry);
      while (entry.link) {
        const link = this.getEntry(entry.link, cache);
        entries.push(link);
        entry = link;
      }
    }

    if (!alreadyOpen)
      await this.store.close();

    return entries;
  }
}

export enum SkipListValueType {
  Null,
  Boolean,
  Number,
  String
}

export type SkipListValue = null | boolean | number | string;

export class SkipListNode {
  public value: SkipListValue;
  public levels: number[];

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
        throw new Error('levels is required');
      if (typeof value == 'number' && !Number.isFinite(value))
        throw new Error('Number value must be finite');
      this.value = value == null ? null : value;
      this.levels = levels;
    } else {
      const encodedNode = obj as string;
      const parts = encodedNode.split(';');
      const [encodedLevels, encodedType] = parts.slice(0, 2);
      const type = z85DecodeAsUInt32(encodedType);
      this.value = SkipListNode.decodeValue(type, parts.slice(2).join(';'));
      this.levels = encodedLevels.split(',').map(
        s => z85DecodeAsUInt32(s)
      );
    }
  }

  next(level: number) {
    return this.levels[level];
  }

  encoded() {
    const encodedLevels = this.levels.map(l => z85EncodeAsUInt32(l)).join(',');

    const encodedType = z85EncodeAsUInt32(this.type, false);

    let encodedValue = '';
    if (typeof this.value == 'boolean')
      encodedValue = z85EncodeAsUInt32(Number(this.value), false);
    else if (typeof this.value == 'number')
      encodedValue = z85EncodeAsDouble(this.value, false);
    else if (typeof this.value == 'string')
      encodedValue = this.value;

    return `${encodedLevels};${encodedType};${encodedValue}`;
  }

  protected static decodeValue(type: SkipListValueType, value: string) {
    switch (type) {
      case SkipListValueType.Boolean:
        return Boolean(z85DecodeAsUInt32(value));
      case SkipListValueType.Number:
        return z85DecodeAsDouble(value);
      case SkipListValueType.String:
        return value;
      default:
        return null;
    }
  }
}

export class IndexEntry {
  field: string;
  pointer: number;
  node: SkipListNode;
  position: number = 0;
  link: number = 0;

  constructor(serializedEntry: SerializedIndexEntry);
  constructor(field: string, pointer: number, node: SkipListNode);
  constructor(obj: any, pointer?: number, node?: SkipListNode) {
    if (typeof obj == 'string') {
      const field = obj;
      if (pointer == null || !node)
        throw new Error('pointer and node are required');
      this.field = field;
      this.pointer = pointer;
      this.node = node;
    } else {
      const serializedEntry = obj as SerializedIndexEntry;
      this.field = Object.keys(serializedEntry)[0];
      const encodedParts = serializedEntry[this.field].split(';');
      const encodedPointer = encodedParts[0];
      const encodedLink = encodedParts[1];
      const encodedNode = encodedParts.slice(2).join(';');
      this.pointer = z85DecodeAsUInt32(encodedPointer);
      this.link = z85DecodeAsUInt32(encodedLink);
      this.node = new SkipListNode(encodedNode);
    }
  }

  encoded() {
    const encodedPointer = z85EncodeAsUInt32(this.pointer);
    const encodedLink = z85EncodeAsUInt32(this.link);
    return `${encodedPointer};${encodedLink};${this.node.encoded()}`;
  }

  serialized(): SerializedIndexEntry {
    return {
      [this.field]: this.encoded()
    };
  }
}

export interface SerializedIndexEntry {
  [field: string]: string;
}

export interface ObjectField {
  field: string;
  value: any;
  position: number;
}

export type IndexCache = Map<number, IndexEntry>;

export default Index;
