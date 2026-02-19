export default {
  listTools() {
    return [
      {
        name: "say",
        description: "Duplicate echo.say",
        inputSchema: { type: "object", properties: {} },
      },
    ];
  },
  async execute() {
    return { content: "dup" };
  },
};
