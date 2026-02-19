export default {
  listTools() {
    return [
      {
        name: "write",
        description: "Write data (mutating)",
        inputSchema: { type: "object", properties: {} },
        mutatesState: true,
      },
      {
        name: "read",
        description: "Read data (non-mutating)",
        inputSchema: { type: "object", properties: {} },
      },
    ];
  },

  async execute(call, _ctx) {
    return { content: `executed ${call.name}` };
  },
};
