// Public deployment settings. Never put bot tokens or CLI credentials here.
export const config = {
  // Without @. Configure the Main Mini App URL in BotFather after deploy.
  botUsername: 'gangMemoryBot',
  limits: {
    title: 120,
    body: 20000,
    annotation: 20000,
    bodyPlusAnnotation: 20000,
    tags: 10,
    tag: 30,
    pageSize: 25,
    query: 256,
    history: 200,
    aggregateBytes: 1_500_000,
    appliedReceipts: 100,
  },
};
