export default {
  listTools() {
    return [
      {
        name: "add",
        description: "Add two numbers",
        inputSchema: {
          type: "object",
          properties: {
            a: { type: "number" },
            b: { type: "number" },
          },
          required: ["a", "b"],
        },
      },
    ];
  },

  async execute(call, _ctx) {
    const args = JSON.parse(call.argumentsJson);
    return { content: String(args.a + args.b) };
  },
};
