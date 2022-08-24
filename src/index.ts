import {
  brokerWrapper,
  FLAKY_EXCHANGE_NAME,
  getCompleteUri,
  ScenarioExecutionResult,
  ScenarioExecutionResultModel,
  TestFailuresModel,
  TestRunModel,
} from 'flaky-common';
import {ProjectTestEndListener} from './messages/listeners/project-test-end-listener';
import {mongoose} from '@typegoose/typegoose';
import cron from 'node-cron';
import {createClient} from 'redis';

let jobExecuting = false;

async function start() {
  if (!process.env.FLAKY_MONGO_URI)
    throw new Error('FLAKY_MONGO_URI must be defined');
  if (!process.env.FLAKY_MONGO_USERNAME)
    throw new Error('FLAKY_MONGO_USERNAME must be defined');
  if (!process.env.FLAKY_MONGO_PASSWORD)
    throw new Error('FLAKY_MONGO_PASSWORD must be defined');
  if (!process.env.FLAKY_RABBITMQ_URI)
    throw new Error('FLAKY_RABBITMQ_URI must be defined');
  if (!process.env.FLAKY_RABBITMQ_USERNAME)
    throw new Error('FLAKY_RABBITMQ_USERNAME must be defined');
  if (!process.env.FLAKY_RABBITMQ_PASSWORD)
    throw new Error('FLAKY_RABBITMQ_PASSWORD must be defined');
  const mongoUri = getCompleteUri(
    process.env.FLAKY_MONGO_URI,
    process.env.FLAKY_MONGO_USERNAME,
    process.env.FLAKY_MONGO_PASSWORD
  );
  const rabbitUri = getCompleteUri(
    process.env.FLAKY_RABBITMQ_URI,
    process.env.FLAKY_RABBITMQ_USERNAME,
    process.env.FLAKY_RABBITMQ_PASSWORD
  );
  await brokerWrapper.connect(rabbitUri, FLAKY_EXCHANGE_NAME, 'topic');
  await mongoose.connect(mongoUri);
  await new ProjectTestEndListener(brokerWrapper).listen();

  cron.schedule('* * * * *', checkResults);
}

async function checkResults() {
  {
    if (jobExecuting == true) {
      console.log('Job already running');
      return;
    }
    try {
      const client = createClient({url: process.env.FLAKY_REDIS_URI});
      await client.connect();

      const resultsQueue = await client.keys('project-*-results::*');

      resultsQueue.forEach(async resultQueue => {
        const numberOfScenarios = Number(resultQueue.split('::')[1]);

        const alreadyProcessedScenarios = await client.lLen(resultQueue);

        if (alreadyProcessedScenarios === numberOfScenarios) {
          jobExecuting = true;
          const testRun = await TestRunModel.findById(
            resultQueue.split('-')[1]
          );
          if (!testRun) {
            throw new Error('Test run not found!');
          }

          const allConfigExecutionResultsJson = await client.lRange(
            resultQueue,
            0,
            numberOfScenarios - 1
          );
          const allConfigExecutionResults = allConfigExecutionResultsJson.map(
            singleConfigExecutionResultJson =>
              JSON.parse(singleConfigExecutionResultJson)
          );
          const configWithSameFailureRate = allConfigExecutionResults.filter(
            singleConfigExecutionResult =>
              singleConfigExecutionResult.failureRate === 0
          );
          if (
            configWithSameFailureRate.length === 0 ||
            configWithSameFailureRate.length === numberOfScenarios
          ) {
            console.log('No flaky detected');
            testRun.isFlaky = false;
          } else {
            const baseResult = allConfigExecutionResults.filter(
              singleConfigExecutionResult =>
                'base' in
                JSON.parse(singleConfigExecutionResult.scenarioConfiguration)
            )[0];

            const scenariosGrouped = allConfigExecutionResults.reduce(
              (acc, scenarioConfig) => {
                if (
                  'concurrency' in
                  JSON.parse(scenarioConfig.scenarioConfiguration)
                ) {
                  return {
                    ...acc,
                    concurrency: [...acc.concurrency, scenarioConfig],
                  };
                } else if (
                  'memory' in JSON.parse(scenarioConfig.scenarioConfiguration)
                ) {
                  return {...acc, memory: [...acc.memory, scenarioConfig]};
                } else if (
                  'diskio' in JSON.parse(scenarioConfig.scenarioConfiguration)
                ) {
                  return {...acc, diskio: [...acc.diskio, scenarioConfig]};
                } else if (
                  'order' in JSON.parse(scenarioConfig.scenarioConfiguration)
                ) {
                  return {...acc, order: [...acc.order, scenarioConfig]};
                } else {
                  return acc;
                }
              },
              {concurrency: [], memory: [], diskio: [], order: []}
            );

            const scenariosResult = Object.keys(scenariosGrouped)
              .map(group =>
                scenariosGrouped[group].reduce(
                  (acc: any, concurrencyConfig: any) => {
                    const {executionWithFailure, numberOfRuns, duration} =
                      concurrencyConfig;
                    return {
                      name: group,
                      executionWithFailure:
                        acc.executionWithFailure + executionWithFailure,
                      numberOfRuns: acc.numberOfRuns + numberOfRuns,
                      duration: acc.duration + Number(duration),
                    };
                  },
                  {executionWithFailure: 0, numberOfRuns: 0, duration: 0}
                )
              )
              .map(executionScenario => ({
                ...executionScenario,
                failureRate:
                  executionScenario.executionWithFailure /
                    executionScenario.numberOfRuns || 0,
              }));

            let rootCauseConfig: ScenarioExecutionResult;
            let rootCauseScenario: any;
            if (baseResult.failureRate === 0) {
              rootCauseConfig = allConfigExecutionResults.reduce((prev, curr) =>
                prev.failureRate > curr.failureRate ? prev : curr
              );
              rootCauseScenario = scenariosResult.reduce((prev, curr) =>
                prev.failureRate > curr.failureRate ? prev : curr
              );
            } else {
              rootCauseConfig = allConfigExecutionResults.reduce((prev, curr) =>
                Math.abs(prev.failureRate - baseResult.failureRate) >
                Math.abs(curr.failureRate - baseResult.failureRate)
                  ? prev
                  : curr
              );
              rootCauseScenario = scenariosResult.reduce((prev, curr) =>
                Math.abs(prev.failureRate - baseResult.failureRate) >
                Math.abs(curr.failureRate - baseResult.failureRate)
                  ? prev
                  : curr
              );
            }

            console.log(rootCauseScenario);

            console.log(
              `Finished processing the data relating to the ${
                resultQueue.split('-')[1]
              } test run`
            );

            testRun.isFlaky = true;
            testRun.rootCause = rootCauseConfig;
          }

          const allConfigExecutionResultsModified = await Promise.all(
            allConfigExecutionResults.map(async configExecutionResult => {
              let testExecutionsResults =
                configExecutionResult!.testExecutionsResults!;
              testExecutionsResults = await Promise.all(
                testExecutionsResults.map(async (testExecutionResult: any) => {
                  const savedExecutionResult = await TestFailuresModel.create(
                    testExecutionResult
                  );
                  return savedExecutionResult._id as mongoose.Types.ObjectId;

                  // if (testExecutionResult.testCases) {
                  //   const savedExecutionResults = await Promise.all(
                  //     testExecutionResult.testCases!.map(
                  //       async (testCase: any) => {
                  //         const savedTestCase =
                  //           await TestExecutionResultModel.create(testCase);
                  //         return savedTestCase._id as mongoose.Types.ObjectId;
                  //       }
                  //     )
                  //   );
                  //   testExecutionResult.testCases = savedExecutionResults;
                  //   return testExecutionResult;
                  // }
                })
              );
              configExecutionResult.testExecutionsResults =
                testExecutionsResults;
              return configExecutionResult;
            })
          );

          const scenarioExecutionResultsId = await Promise.all(
            allConfigExecutionResultsModified.map(
              async configExecutionResult => {
                const savedScenarioExecutionResult =
                  await ScenarioExecutionResultModel.create(
                    configExecutionResult
                  );
                return savedScenarioExecutionResult._id as mongoose.Types.ObjectId;
              }
            )
          );

          testRun.scenarioExecutionsResult = scenarioExecutionResultsId;
          await testRun.save();
          await client.del(resultQueue);
        }
        await client.quit();
        jobExecuting = false;
      });
    } catch (err: any) {
      console.log(err);
    }
  }
}

start();
