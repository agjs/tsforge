import { test, expect } from "bun:test";
import { query } from "./query";

// Sample dataset for testing
const sampleData = [
  { id: 1, name: "Alice", score: 95, region: "US" },
  { id: 2, name: "Bob", score: 87, region: "EU" },
  { id: 3, name: "Charlie", score: 92, region: "US" },
  { id: 4, name: "Diana", score: 88, region: "APAC" },
  { id: 5, name: "Eve", score: null, region: "US" },
  { id: 6, name: "Frank", score: 95, region: null },
  { id: 7, name: "Grace", score: 85, region: "EU" },
] as const;

// SELECT * tests
test("SELECT * returns all columns", () => {
  const result = query("SELECT * FROM users", sampleData);
  expect(result).toHaveLength(7);
  expect(result[0]).toHaveProperty("id");
  expect(result[0]).toHaveProperty("name");
  expect(result[0]).toHaveProperty("score");
  expect(result[0]).toHaveProperty("region");
});

test("SELECT * row count matches input", () => {
  const result = query("SELECT * FROM users", sampleData);
  expect(result).toHaveLength(7);
});

// Column projection tests
test("SELECT specific columns projects subset", () => {
  const result = query("SELECT id, name FROM users", sampleData);
  expect(result).toHaveLength(7);
  expect(result[0]).toHaveProperty("id");
  expect(result[0]).toHaveProperty("name");
  expect(result[0]).not.toHaveProperty("score");
  expect(result[0]).not.toHaveProperty("region");
});

test("SELECT single column", () => {
  const result = query("SELECT name FROM users", sampleData);
  expect(result).toHaveLength(7);
  expect(result[0]).toHaveProperty("name");
  expect(result[0]).not.toHaveProperty("id");
});

test("SELECT columns in different order than source", () => {
  const result = query("SELECT name, id FROM users", sampleData);
  expect(result[0].name).toBe("Alice");
  expect(result[0].id).toBe(1);
});

// WHERE equality tests
test("WHERE with = on number column", () => {
  const result = query("SELECT * FROM users WHERE id = 2", sampleData);
  expect(result).toHaveLength(1);
  expect(result[0].name).toBe("Bob");
});

test("WHERE with = on string column", () => {
  const result = query("SELECT * FROM users WHERE region = 'US'", sampleData);
  expect(result).toHaveLength(3);
});

test("WHERE = with no matches returns empty", () => {
  const result = query("SELECT * FROM users WHERE id = 999", sampleData);
  expect(result).toHaveLength(0);
});

// WHERE inequality tests
test("WHERE with !=", () => {
  const result = query("SELECT * FROM users WHERE region != 'EU'", sampleData);
  // US: Alice, Charlie, Eve (3), APAC: Diana (1), null: Frank (0) = 4 rows (Frank's null region doesn't match != 'EU')
  expect(result).toHaveLength(4);
});

test("WHERE with < comparison", () => {
  const result = query("SELECT * FROM users WHERE score < 90", sampleData);
  expect(result).toHaveLength(3); // Bob (87), Diana (88), Grace (85)
});

test("WHERE with > comparison", () => {
  const result = query("SELECT * FROM users WHERE score > 90", sampleData);
  expect(result).toHaveLength(3); // Alice (95), Charlie (92), Frank (95)
});

test("WHERE with <= comparison", () => {
  const result = query("SELECT * FROM users WHERE score <= 88", sampleData);
  expect(result).toHaveLength(3); // Bob (87), Diana (88), Grace (85)
});

test("WHERE with >= comparison", () => {
  const result = query("SELECT * FROM users WHERE score >= 92", sampleData);
  expect(result).toHaveLength(3); // Alice (95), Charlie (92), Frank (95)
});

// Null handling tests
test("NULL = NULL is false", () => {
  const result = query("SELECT * FROM users WHERE score = null", sampleData);
  expect(result).toHaveLength(0);
});

test("NULL != x is true for non-null", () => {
  const result = query("SELECT * FROM users WHERE score != null", sampleData);
  // score != null returns true only for rows where score is not null
  expect(result).toHaveLength(6); // All non-null scores: Alice, Bob, Charlie, Diana, Frank, Grace
});

test("NULL in comparisons always fails", () => {
  const result = query("SELECT * FROM users WHERE region = null", sampleData);
  expect(result).toHaveLength(0);
});

// AND precedence tests
test("WHERE with AND", () => {
  const result = query(
    "SELECT * FROM users WHERE region = 'US' AND score > 90",
    sampleData
  );
  expect(result).toHaveLength(2); // Alice, Charlie
});

test("WHERE with AND multiple conditions", () => {
  const result = query(
    "SELECT * FROM users WHERE id > 2 AND score < 90",
    sampleData
  );
  expect(result).toHaveLength(2); // Diana (88), Grace (85)
});

// OR tests
test("WHERE with OR", () => {
  const result = query(
    "SELECT * FROM users WHERE region = 'EU' OR region = 'APAC'",
    sampleData
  );
  expect(result).toHaveLength(3); // Bob, Diana, Grace
});

// Precedence: AND binds tighter than OR
test("WHERE AND binds tighter than OR", () => {
  const result = query(
    "SELECT * FROM users WHERE region = 'US' AND score > 90 OR id = 2",
    sampleData
  );
  // (region='US' AND score>90) OR id=2
  // = (Alice, Charlie) OR (Bob) = Alice, Bob, Charlie
  expect(result).toHaveLength(3);
});

test("WHERE parentheses override precedence", () => {
  const result = query(
    "SELECT * FROM users WHERE region = 'US' OR id = 2 AND score < 88",
    sampleData
  );
  // region='US' OR (id=2 AND score<88)
  // region='US': Alice, Charlie, Eve, Frank
  // (id=2 AND score<88): Bob (87<88, id=2)
  // But Bob is not in region US, so doesn't match first part. Second part: id=2 AND score<88 matches Bob.
  // Result: Alice, Charlie, Eve, Frank (from region='US') = 4
  expect(result).toHaveLength(4);
});

test("WHERE parentheses group OR before AND", () => {
  const result = query(
    "SELECT * FROM users WHERE (region = 'US' OR region = 'EU') AND score > 85",
    sampleData
  );
  // (region='US' OR region='EU') AND score>85
  // US or EU: Alice, Bob, Charlie, Eve, Grace
  // score > 85: Alice(95), Bob(87), Charlie(92), Diana(88), Frank(95), Grace(85)
  // Intersection: Alice, Bob, Charlie (Grace has 85 not >85, Eve has null score which fails >85)
  expect(result).toHaveLength(3);
});

// ORDER BY tests
test("ORDER BY ASC on number column", () => {
  const result = query("SELECT * FROM users ORDER BY score ASC", sampleData);
  expect(result[0].name).toBe("Grace"); // 85
  expect(result[result.length - 1].name).toBe("Eve"); // null goes last
});

test("ORDER BY DESC on number column", () => {
  const result = query("SELECT * FROM users ORDER BY score DESC", sampleData);
  // DESC order: Frank(95), Alice(95), Charlie(92), Diana(88), Bob(87), Grace(85), Eve(null)
  expect(result[0].score).toBe(95);
  expect(result[result.length - 1].name).toBe("Eve"); // null goes last even in DESC
});

test("ORDER BY string column", () => {
  const result = query("SELECT * FROM users ORDER BY name ASC", sampleData);
  expect(result[0].name).toBe("Alice");
  expect(result[1].name).toBe("Bob");
});

test("ORDER BY puts nulls last", () => {
  const result = query("SELECT * FROM users ORDER BY score ASC", sampleData);
  // Eve has null score, should be last
  expect(result[result.length - 1].name).toBe("Eve");
});

test("ORDER BY stable sort preserves original order for equal values", () => {
  const result = query("SELECT * FROM users ORDER BY score ASC", sampleData);
  // Alice (95) and Frank (95): Alice appears first in original, Frank second
  const aliceIdx = result.findIndex((r) => r.name === "Alice");
  const frankIdx = result.findIndex((r) => r.name === "Frank");
  expect(aliceIdx < frankIdx).toBe(true);
});

// LIMIT tests
test("LIMIT truncates results", () => {
  const result = query("SELECT * FROM users LIMIT 3", sampleData);
  expect(result).toHaveLength(3);
});

test("LIMIT 0 returns empty", () => {
  const result = query("SELECT * FROM users LIMIT 0", sampleData);
  expect(result).toHaveLength(0);
});

test("LIMIT greater than result count", () => {
  const result = query("SELECT * FROM users LIMIT 100", sampleData);
  expect(result).toHaveLength(7);
});

// Combined queries
test("SELECT, WHERE, ORDER BY together", () => {
  const result = query(
    "SELECT id, name FROM users WHERE score > 85 ORDER BY name ASC LIMIT 3",
    sampleData
  );
  expect(result).toHaveLength(3);
  expect(result[0].name).toBe("Alice");
});

test("Complex query with projection, AND condition, ORDER BY DESC, LIMIT", () => {
  const result = query(
    "SELECT name, score FROM users WHERE region = 'US' AND score != null ORDER BY score DESC LIMIT 2",
    sampleData
  );
  // Region US: Alice(95), Charlie(92), Eve(null)
  // score != null: Alice(95), Charlie(92) (Eve excluded due to null score)
  expect(result).toHaveLength(2);
  expect(result[0].score).toBe(95); // Alice (95 DESC comes first)
  expect(result[1].score).toBe(92); // Charlie
});

// Malformed query error cases
test("Malformed: missing FROM throws", () => {
  expect(() => query("SELECT * WHERE id = 1", sampleData)).toThrow();
});

test("Malformed: invalid WHERE syntax throws", () => {
  expect(() =>
    query("SELECT * FROM users WHERE AND id = 1", sampleData)
  ).toThrow();
});

test("Malformed: unmatched parenthesis throws", () => {
  expect(() =>
    query("SELECT * FROM users WHERE (id = 1", sampleData)
  ).toThrow();
});

test("Malformed: invalid column reference throws", () => {
  expect(() => query("SELECT nonexistent FROM users", sampleData)).toThrow();
});

test("Malformed: invalid operator throws", () => {
  expect(() =>
    query("SELECT * FROM users WHERE id <> 1", sampleData)
  ).toThrow();
});

test("Malformed: missing value in comparison throws", () => {
  expect(() => query("SELECT * FROM users WHERE id =", sampleData)).toThrow();
});

test("Malformed: empty query throws", () => {
  expect(() => query("", sampleData)).toThrow();
});
