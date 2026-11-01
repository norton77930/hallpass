// 027 T845: a minimal MCP server over stdio for the Check tests. TINY_MCP_MODE selects a behaviour:
// unset - two tools; `exit` - prints an error to stderr (with TINY_SECRET's value) and exits 1;
// `hang` - never answers.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const mode = process.env.TINY_MCP_MODE;
if (mode === "exit") {
  process.stderr.write(`could not log in with key ${process.env.TINY_SECRET ?? "none"}\n`);
  process.exit(1);
}
if (mode === "hang") {
  setInterval(() => undefined, 60_000);
} else {
  const server = new McpServer({ name: "tiny", version: "0.0.0" });
  server.registerTool("echo_back", { description: "Echo." }, async () => ({ content: [{ type: "text", text: "ok" }] }));
  server.registerTool("count_things", { description: "Count." }, async () => ({ content: [{ type: "text", text: "2" }] }));
  await server.connect(new StdioServerTransport());
}
