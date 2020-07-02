import {
  APIGatewayProxyHandler,
  EventBridgeHandler,
} from "aws-lambda";
import { metricScope, createMetricsLogger } from "aws-embedded-metrics";
import "source-map-support/register";

import * as uninstrumentedAWS from "aws-sdk";
import * as AWSXRay from "aws-xray-sdk";
const AWS = AWSXRay.captureAWS(uninstrumentedAWS);

// Test the API Gateway to Lambda X-Ray tracing.
export const world: APIGatewayProxyHandler = async (_event, _context) => {
  metricScope((metrics) => async () => {
    metrics.putMetric("worldApiRequestsHandled", 1);
  });
  // Add a Call to DynamoDB to test X-Ray going through API Gateway and Lambda.
  const client = new AWS.DynamoDB.DocumentClient();
  await client
    .put({ TableName: "worldTable", Item: { _id: new Date().toISOString() } })
    .promise();
  return {
    statusCode: 200,
    body: JSON.stringify({
      message: "Remote service OK!",
    }),
  };
};

// This handler logs that events happened.
export const worldEvent: EventBridgeHandler<any, any, any> = async (
  event,
  context
) => {
  const metrics = createMetricsLogger();
  try {
    metrics.putMetric("worldEventsHandled", 1);
    metrics.setProperty("worldEventSource", event.source);
    metrics.setProperty("worldEventDetail", event.detail);

    console.log(JSON.stringify(event));
    console.log(JSON.stringify(context));

    const client = new AWS.DynamoDB.DocumentClient();
    await client
      .put({ TableName: "worldTable", Item: { _id: new Date().toISOString() } })
      .promise();
  } finally {
    await metrics.flush();
  }
};
