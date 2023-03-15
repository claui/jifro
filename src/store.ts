interface Store<T> {
  get(position: number): Promise<{
    value: T, start: number, length: number
  }>;
}

export default Store;
