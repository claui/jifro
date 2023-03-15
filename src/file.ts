import { EventEmitter } from 'events';
import { promises as fs } from 'fs';
import { FileHandle } from 'fs/promises';

import { logger, read } from './utils';

class File extends EventEmitter {
  protected file: FileHandle | null = null;
  protected logger = logger('file');
  protected reads = 0;

  constructor(protected filename: string) {
    super();
  }

  get isOpen() {
    return this.file != null;
  }

  read(position: number, reverse = false, buffer?: Buffer) {
    ++this.reads;
    if (!this.file)
      throw new Error('Need to call open() before read()');
    return read(this.file, position, reverse, buffer);
  }

  async open(mode = 'r+') {
    this.logger.log('opening', this.filename);
    if (this.isOpen)
      throw new Error('File already open');
    this.file = await fs.open(this.filename, mode);
  }

  async close() {
    this.logger.log('closing', this.filename);
    this.logger.log('reads', this.reads);
    if (!this.file)
      throw new Error('No open file to close');
    await this.file.close();
    this.file = null;
    this.reads = 0;
  }
}

export default File;
