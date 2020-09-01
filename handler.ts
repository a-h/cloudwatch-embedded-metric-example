import {
  APIGatewayProxyHandler,
  APIGatewayProxyEvent,
  Context,
} from "aws-lambda";
import { createMetricsLogger, MetricsLogger } from "aws-embedded-metrics";
import { Subsegment } from "aws-xray-sdk";
import "source-map-support/register";

import * as uninstrumentedAWS from "aws-sdk";
import * as AWSXRay from "aws-xray-sdk";
const AWS = AWSXRay.captureAWS(uninstrumentedAWS);

import * as http from "http";
AWSXRay.captureHTTPsGlobal(http, true);

import * as https from "https";
AWSXRay.captureHTTPsGlobal(https, true);

// Make sure you capture HTTPS before you import axios.
import axios from "axios";

const helloFunction = async (
  _event: APIGatewayProxyEvent,
  _context: Context,
  metrics: MetricsLogger,
  parent: Subsegment
) => {
  await AWSXRay.captureAsyncFunc(
    "makeApiCalls",
    async (segment) => {
      try {
        try {
          await axios.get("http://httpstat.us/500");
        } catch (err) {
          console.log("it's ok for this to fail.");
        }
        await axios.get("https://jsonplaceholder.typicode.com/todos/1");
        metrics.putMetric("exampleApiCallsMade", 2);
      } catch (err) {
        segment.close(err);
        throw err;
      } finally {
        segment.close();
      }
    },
    parent
  );

  await AWSXRay.captureAsyncFunc(
    "doDatabaseAndEventWork",
    async (segment) => {
      try {
        // Add a Call to DynamoDB to test X-Ray.
        const client = new AWS.DynamoDB.DocumentClient();
        await client
          .put({
            TableName: "helloTable",
            Item: { _id: new Date().toISOString() },
          })
          .promise();

        // Send a message to EventBridge to trace through multiple Lambdas.
        const eventBus = new AWS.EventBridge();
        const params: AWS.EventBridge.PutEventsRequest = {
          Entries: [
            {
              Source: "cloudwatch-embedded-metric-example",
              DetailType: "exampleEvent",
              Detail: JSON.stringify({
                message: "Hello...",
              }),
            },
          ],
        };
        await eventBus.putEvents(params).promise();
      } catch (err) {
        segment.close(err);
        throw err;
      } finally {
        segment.close();
      }
    },
    parent
  );

  await AWSXRay.captureAsyncFunc(
    "callWorld",
    async (segment) => {
      try {
        await axios.get(
          "https://osqnssr1sl.execute-api.us-east-1.amazonaws.com/dev/world"
        );
      } catch (err) {
        segment.close(err);
        throw err;
      } finally {
        segment.close();
      }
    },
    parent
  );

  // Call another service via API gateway.

  return {
    statusCode: 200,
    body: JSON.stringify({ ok: true }),
  };
};

// We need to create a subsegment, because in AWS Lambda, the top-level X-Ray segment is readonly.
export const hello: APIGatewayProxyHandler = async (event, context) => {
  const metrics = createMetricsLogger();
  return await AWSXRay.captureAsyncFunc(
    "handler",
    async (segment) => {
      // Annotate the segment with metadata to allow it to be searched.
      segment.addAnnotation("userId", "user123");
      try {
        return await helloFunction(event, context, metrics, segment);
      } catch (err) {
        segment.close(err);
        throw err;
      } finally {
        // Metrics and segments MUST be closed.
        metrics.flush();
        if (!segment.isClosed()) {
          segment.close();
        }
      }
    },
    AWSXRay.getSegment()
  );
};
