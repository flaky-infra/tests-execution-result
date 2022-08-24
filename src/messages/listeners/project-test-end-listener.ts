import {ConsumeMessage} from 'amqplib';
import {randomUUID} from 'crypto';
import {
  EventTypes,
  Listener,
  ProjectTestEndEvent,
  ScenarioExecutionResult,
} from 'flaky-common';
import {createClient} from 'redis';

export class ProjectTestEndListener extends Listener<ProjectTestEndEvent> {
  eventType: EventTypes.ProjectTestEnd = EventTypes.ProjectTestEnd;
  queueName = `tests-execution-result/test-end-${randomUUID()}`;
  routingKey = this.eventType;

  async onMessage(data: ProjectTestEndEvent['data'], msg: ConsumeMessage) {
    const {
      testFailures,
      configFile,
      projectId,
      testRunId,
      scenarioConfiguration,
      testMethodName,
      executionLog,
      numberOfScenarios,
      duration,
    } = data;

    console.log(`${configFile} configuration test completed`);

    const executionWithFailure = testFailures.filter(testFailure => {
      return (
        testFailure.testCases &&
        testFailure.testCases.length !== 0 &&
        testFailure.testCases.filter(
          testCase => testCase.name === testMethodName.split('#')[1]
        ).length !== 0
      );
    }).length;

    const configExecutionResult = {
      scenarioName: configFile,
      scenarioConfiguration: scenarioConfiguration,
      numberOfRuns: testFailures.length,
      executionWithFailure,
      failureRate: executionWithFailure / testFailures.length,
      testExecutionsResults: testFailures,
      executionLog,
      duration,
    };

    try {
      const client = createClient({url: process.env.FLAKY_REDIS_URI});
      await client.connect();

      await client.rPush(
        `project-${testRunId}-results::${numberOfScenarios}`,
        JSON.stringify(configExecutionResult)
      );
      // await client.quit();
    } catch (err) {
      console.log(err);
    }
  }
}
