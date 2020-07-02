import {
  APIGatewayProxyHandler,
  APIGatewayProxyEvent,
  Context,
} from "aws-lambda";
import { Unit, createMetricsLogger, MetricsLogger } from "aws-embedded-metrics";
import "source-map-support/register";
import fetch, { RequestInfo, RequestInit, Response } from "node-fetch";
import { camelCase } from "camel-case";

import * as uninstrumentedAWS from "aws-sdk"
import * as AWSXRay from "aws-xray-sdk"
const AWS = AWSXRay.captureAWS(uninstrumentedAWS);

import * as http from "http";
AWSXRay.captureHTTPsGlobal(http, true);

import * as https from "https";
AWSXRay.captureHTTPsGlobal(https, true);

const helloFunction = async (_event: APIGatewayProxyEvent, _context: Context, metrics: MetricsLogger
) => {
  try {
    await instrumentedFetch("expected failure", metrics, 1000, "http://httpstat.us/500");
  } catch(e) {
    metrics.setProperty("statServiceError", e);
    metrics.putMetric("statServiceFailures", 1);
  }
  await instrumentedFetch("expected OK", metrics, 1000, "https://jsonplaceholder.typicode.com/todos/1");

  // Add a Call to DynamoDB to test X-Ray.
  const client = new AWS.DynamoDB.DocumentClient();
  await client.put({ TableName: "helloTable", Item: { "_id": (new Date()).toISOString() }}).promise();

  // Send a message to EventBridge to trace through multiple Lambdas.
  const eventBus = new AWS.EventBridge();
  const params: AWS.EventBridge.PutEventsRequest = {
      Entries: [{
            Source: "cloudwatch-embedded-metric-example",
            DetailType: "exampleEvent",
            Detail: JSON.stringify({
              "message": "Hello...",
            }),
        }]
  };
  await eventBus.putEvents(params).promise();

  // Call another service via API gateway.
  // Use standard fetch, to demonstrate that all HTTPS requests are catpured with X-Ray alone.
  await fetch("https://osqnssr1sl.execute-api.us-east-1.amazonaws.com/dev/world")

  return {
    statusCode: 200,
    body: JSON.stringify({ ok: true }),
  };
};

const timeout = async <T>(ms: number, promise: Promise<T>): Promise<T> => 
  new Promise<T>(async (resolve, reject) => {
      setTimeout(() => {
          reject(new Error("timeout"))
      }, ms);
      resolve(await promise);
  });

export const instrumentedFetch = async (
  name: string,
  metrics: MetricsLogger,
  timeoutMS: number,
  url: RequestInfo,
  init?: RequestInit
): Promise<Response> => {
  const prefix = camelCase(name);
  const endTimer = startTimer();
  try {
    const response = await timeout<Response>(timeoutMS, fetch(url, init));
    metrics.putMetric(`${prefix}_fetchStatus`, response.status);
    return response;
  } catch (e) {
    metrics.setProperty(`${prefix}_fetchError`, e);
    metrics.putMetric(`${prefix}_fetchErrors`, 1);
    throw e;
  } finally {
    metrics.putMetric(`${prefix}_fetchResponseTime`, endTimer(), Unit.Milliseconds);
  }
};

const startTimer = () => {
  const start = process.hrtime();
  return () => {
    const [secs, nsecs] = process.hrtime(start);
    return (secs * 1000) + (nsecs / 1000000);
  };
};

export const hello: APIGatewayProxyHandler = async (event, context) => {
  // Name the logging.
  const prefix = "helloFunction";
  // Start the timer.
  const endTimer = startTimer();

  // Use the CloudWatch Metrics Exporter.
  const metrics = createMetricsLogger();
  try {
    // Execute our code.
    const response = await helloFunction(event, context, metrics);

    // Record the response in the metrics.
    metrics.putMetric(`${prefix}_handlerStatus`, response.statusCode);

    // Return the response.
    return response;
  } catch (e) {
    // Log if an unchecked error happened.
    metrics.setProperty(`${prefix}_handlerErrorMessage`, e)
    metrics.putMetric(`${prefix}_handlerErrors`, 1);
    throw e;
  } finally {
    // Record the time taken no matter what happened.
    // This isn't really required, because you can track it by the Lambda execution time, or the API
    // Gateway latency.
    metrics.putMetric(`${prefix}_handlerResponseTime`, endTimer(), Unit.Milliseconds);

    // Flush all the metrics.
    await metrics.flush();
  }
};
