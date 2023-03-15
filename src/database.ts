import * as path from 'path';

import Index from './index';
import JSONStore from './json-store';
import { Query } from './query';
import { logger } from './utils';

class DatabaseIterableIterator<T> implements AsyncIterableIterator<T> {
  constructor(protected iterator: AsyncIterableIterator<[number, T]>) { }
  async next() {
    const res = (await this.iterator.next()) as IteratorResult<any>;
    if (!res.done)
      res.value = res.value[1];
    return res as IteratorResult<T>;
  }
  async toArray() {
    const array = [];
    for await (const i of this)
      array.push(i);
    return array;
  }
  [Symbol.asyncIterator]() {
    return this;
  }
}

class Database<T extends Record = Record> {
  protected store: JSONStore<T>;
  protected _index: Index;
  protected logger = logger('database');

  constructor(filename: string) {
    this.store = new JSONStore<T>(filename);

    const dirname = path.dirname(filename);
    const ext = path.extname(filename);
    const basename = path.basename(filename, ext);
    const indexFilename = `${path.join(dirname, basename)}.index${ext}`;
    this._index = new Index(indexFilename);
  }

  find(...queries: Query[]) {
    return new DatabaseIterableIterator<T>(async function* (this: Database<T>) {
      let positions: Set<number> | undefined;

      let indexAlreadyOpen = this._index.isOpen;

      if (!indexAlreadyOpen)
        await this._index.open();

      for (const query of queries) {
        const queryPositions = await this.findQuery(query);
        if (!positions) {
          positions = queryPositions;
          continue;
        }
        for (const position of queryPositions)
          positions.add(position);
      }

      if (!indexAlreadyOpen)
        await this._index.close();

      if (!positions)
        return;

      const alreadyOpen = this.store.isOpen;
      if (!alreadyOpen)
        await this.store.open();
      try {
        for (const position of positions) {
          const res = await this.store.get(position);
          yield [res.start, res.value] as [number, T];
        }
      } finally {
        if (!alreadyOpen)
          await this.store.close();
      }
    }.bind(this)());
  }

  protected async findQuery(query: Query) {
    this.logger.time('find');
    let positions: Set<number> | undefined;
    for (const field in query) {
      if (positions && !positions.size)
        break;

      let predicate = query[field];
      if (typeof predicate != 'function') {
        let start = predicate;
        let converted = false;
        predicate = (value: any) => {
          if (predicate.key && !converted) {
            start = predicate.key(start);
            converted = true;
          }
          return {
            seek: value < start ? -1 : value > start ? 1 : 0,
            match: value == start
          };
        };
      }

      const fieldPositions = await this._index.find(field, predicate);

      if (!positions) {
        positions = fieldPositions;
        continue;
      }

      const intersection = new Set<number>();

      for (const position of fieldPositions)
        if (positions.has(position))
          intersection.add(position);

      positions = intersection;
    }
    positions = positions || new Set();
    this.logger.timeEnd('find');

    return positions;
  }
}

export interface Record {
  [field: string]: any;
}

export default Database;
