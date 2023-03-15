import File from './file';
import Store from './store';
import { Char, readJSON } from './utils';

class JSONStore<T> implements Store<T> {
  protected file: File;

  constructor(filename: string) {
    this.file = new File(filename);
  }

  get isOpen() {
    return this.file.isOpen;
  }

  async open() {
    await this.file.open();
  }

  async close() {
    await this.file.close();
  }

  async get(position: number) {
    const { value, start, length } =
      (await readJSON(this.file.read(position)).next()).value!;
    return { value: value as T, start, length };
  }

  async *getAll() {
    // Allow line-delimited JSON
    const start = Number(
      (await this.file.read(0).next()).value![1] == Char.LeftBracket
    );

    const stream = readJSON(
      this.file.read(start, false, Buffer.alloc(1 << 16))
    );

    let res;
    while (!(res = await stream.next()).done) {
      const result = res.value!;
      yield [result.start, result.value];
    }
  }
}

export default JSONStore;
