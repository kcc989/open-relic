/** Stored bytes that cannot be interpreted as their declared Git object type. */
export class ObjectParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ObjectParseError";
  }
}
