export default {
  listTools() {
    return [
      {
        name: "say",
        description: "Echo back the input text",
        inputSchema: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
        },
      },
    ];
  },

  async execute(call, _ctx) {
    const args = JSON.parse(call.argumentsJson);
    return { content: args.text };
  },
};
