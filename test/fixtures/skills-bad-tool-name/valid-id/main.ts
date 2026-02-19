export default {
  listTools() {
    return [
      {
        name: "bad.tool",
        description: "Tool with dots in name",
        inputSchema: { type: "object", properties: {} },
      },
    ];
  },
  async execute() {
    return { content: "" };
  },
};
