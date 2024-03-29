import {ChildProcess, spawn} from 'child_process';
import path, { join } from 'path';
import crypto from 'crypto';

import cislio from '@cisl/io';
import logger from '@cisl/logger';
import express from '@cisl/express';

import merge from 'lodash.merge';
import TextToSpeechV1 from 'ibm-watson/text-to-speech/v1';

import { createCache, clearCache, cachePath } from './cache';
import fs from 'fs';

interface SpeechParams {
  text: string;
  language?: string;
  lang?: string;
  voice?: string;
  volume?: number;
  cachePath?: string;
  stream?: boolean;
}


interface InstantiatedSpeechParams extends SpeechParams {
  language: string;
  voice: string;
  volume: number;
  timestamp: Date;
  cachePath: string;
  timings?: string[];
}

interface SpeakerWorkerConfig {
  language: string;
  voices: {[language: string]: string};
  volume: number;
  environment?: string;
}

const app = express();
const io = cislio();

let streamProc: ChildProcess;

// const speaker_id = io.config.get('id') || 'speaker-worker';
let config: SpeakerWorkerConfig = {
  language: "en-US",
  voices: {
    "en-US": "LisaVoice"
  },
  volume: 1
};
if (io.config.has('speaker')) {
  config = merge(config, io.config.get('speaker'));
}

const tts = new TextToSpeechV1({});
let voices;
let languages: {[language: string]: string[]} = {};

async function initialize(): Promise<void> {
  logger.info('getting Watson languages');
  const resp = await tts.listVoices({});
  voices = resp.result.voices;
  languages = {};
  for (const voice of voices) {
    if (!languages[voice.language]) {
      languages[voice.language] = [];
    }
    languages[voice.language].push(voice.name.split('_')[1]);
  }
  for (const key in languages) {
    languages[key].sort((a: string, b: string): number => {
      // all voices coming from Watson end with "Voice" suffix
      const SUFFIX_LENGTH = "Voice".length;
      a = a.substring(0, a.length - SUFFIX_LENGTH);
      b = b.substring(0, b.length - SUFFIX_LENGTH);
      if (a < b) {
        return -1;
      }
      else if (a === b) {
        return 0;
      }
      else {
        return 1;
      }
    });
  }
}

function getParameters(params: SpeechParams): InstantiatedSpeechParams {
  if (params.lang) {
    params.language = params.lang;
  }

  if (!params.language && params.voice) {
    const match = params.voice.match(/^([a-z]{2}-[A-Z]{2})_/);
    if (match) {
      params.language = match[1];
      params.voice = params.voice.substring(params.language.length + 1);
    }
  }

  params = Object.assign(
    {
      language: config.language,
      volume: config.volume,
      pan: [],
      timestamp: new Date()
    },
    params
  );

  if (!params.voice && params.language) {
    if (config.voices[params.language]) {
      params.voice = config.voices[params.language];
    }
    else {
      params.voice = languages[params.language][0];
    }
  }

  if (!params.cachePath) {
    params.cachePath = crypto
      .createHash('sha1')
      .update(`${params.language}|${params.voice}|${params.text}`)
      .digest('hex');
  }


  return (params as InstantiatedSpeechParams);
}

function synthesizeSpeech(params: SpeechParams, reply: (message: {status: string; message?: string; data?: InstantiatedSpeechParams }) => void): void {
  const instantiatedParams = getParameters(params);

  if (!reply) {
    reply = (): void => {
      return;
    };
  }

  if (!instantiatedParams.text) {
    return reply({
      status: 'error',
      message: 'text parameter is missing'
    });
  }

  logger.info(`Speaking: ${instantiatedParams.text}`);
  if (io.rabbit) {
    io.rabbit.publishTopic('speaker.speak.begin', instantiatedParams);
  }

  app.wsServer.clients.forEach((client) => {
    client.send(JSON.stringify({
      type: 'history',
      text: instantiatedParams.text,
      language: instantiatedParams.language,
      voice: instantiatedParams.voice,
      timestamp: instantiatedParams.timestamp.toLocaleTimeString(undefined, {hour12: false})
    }));
  });

  const fullCachePath = join(cachePath, instantiatedParams.cachePath);
  const cacheExists = fs.existsSync(fullCachePath);

  console.time(`${instantiatedParams.cachePath}_cmd`);

  streamProc = spawn('node', [path.resolve(__dirname, '..', 'dist', 'stream.js'), JSON.stringify(instantiatedParams)], {stdio: 'inherit'});
  streamProc.unref();
  streamProc.on('exit', (exitCode, signal) => {
    if (exitCode === null && signal === 'SIGILL' && process.platform === 'darwin') {
      exitCode = 0;
    }
    // console.log(`exitCode: ${exitCode}`);
    console.timeEnd(`${instantiatedParams.cachePath}_cmd`);
    if (fs.existsSync(`${fullCachePath}_timings.json`)) {
      instantiatedParams.timings = JSON.parse(fs.readFileSync(`${fullCachePath}_timings.json`, {encoding: 'utf-8'}));
    }

    if (io.rabbit) {
      io.rabbit.publishTopic('speaker.speak.end', instantiatedParams);
    }

    if (exitCode === 0) {
      reply({
        status: 'success',
        data: instantiatedParams
      });
    }
    else {
      // if we do not get a 0 exit code, that means the process failed to finish for whatever reason. We then need
      // to delete any partially generated cache files. We know they were generated from this run if they did not exist
      // before starting the process, but do now exist.
      if (!cacheExists) {
        if (fs.existsSync(fullCachePath)) {
          fs.unlinkSync(fullCachePath);
        }
        if (fs.existsSync(`${fullCachePath}_timings.json`)) {
          fs.unlinkSync(`${fullCachePath}_timings.json`);
        }
      }

      reply({
        status: 'error',
        message: 'interrupted',
        data: instantiatedParams
      });
    }
  });
}

function exitHandler(): void {
  if (streamProc) {
    streamProc.kill();
  }

  process.exit(0);
}

function exceptionHandler(err: Error): void {
  logger.error(`Caught exception:`);
  logger.error(`    ${err.stack}`);

  if (streamProc) {
    streamProc.kill();
  }

  process.exit(127);
}

function buildRpcQueueName(method: string): string {
  const parts = ['rpc', 'speaker'];
  if (config.environment) {
    parts.push(config.environment);
  }
  parts.push(method);
  return parts.join('-');
}

if (io.rabbit) {
  io.rabbit.onTopic('speaker.command.cache.clear', () => {
    clearCache();
  });

  io.rabbit.onTopic('speaker.command.default.language', (response) => {
    const msg = (response.content as {language: string});
    if (languages[msg.language]) {
      config.language = msg.language;
      logger.info(`Default language set to ${config.language}`);
    }
    else {
      logger.warn(`Invalid new default language: ${config.language}`);
    }
  });

  io.rabbit.onTopic('speaker.command.default.voice', (response) => {
    const msg = (response.content as {language: string; voice: string});
    if (languages[msg.language]) {
      if (languages[msg.language].includes(msg.voice)) {
        config.voices[msg.language] = msg.voice;
        logger.info(`Default voice for ${msg.language} set to ${msg.voice}`);
      }
      else {
        logger.info(`Invalid default voice for language ${msg.language}: ${msg.voice}`);
      }
    }
    else {
      logger.warn(`Invalid new default language: ${config.language}`);
    }
  });

  io.rabbit.onTopic('speaker.command.volume.change', (response) => {
    const msg = (response.content as {change?: number; volume?: number});
    if (msg.change) {
      config.volume = config.volume + msg.change / 100;
    }
    else if (msg.volume) {
      config.volume = msg.volume;
    }

    config.volume = Math.max(config.volume, 0.0);
    config.volume = Math.min(config.volume, 1.0);

    logger.info(`Set volume to ${config.volume}`);
  });

  io.rabbit.onRpc(buildRpcQueueName('speakText'), (request, reply) => {
    synthesizeSpeech(request.content as SpeechParams, reply);
  });

  io.rabbit.onRpc(buildRpcQueueName('stop'), (_, reply) => {
    if (streamProc) {
      streamProc.kill();
    }
    reply({
      status: 'success'
    });
  });

  io.rabbit.onRpc(buildRpcQueueName('getSynthesizedSpeech'), (message, reply) => {
    const instantiatedParams = getParameters((message.content as SpeechParams));

    if (!instantiatedParams.text) {
      return reply({
        status: 'error',
        message: 'text parameter is missing'
      });
    }

    logger.info(`Synthesizing: ${instantiatedParams.text}`);
    const fullCachePath = join(cachePath, instantiatedParams.cachePath);
    const promises = [Promise.resolve()];
    if (!fs.existsSync(fullCachePath)) {
      const wsParams = {
        accept: 'audio/wav',
        text: instantiatedParams.text,
        voice: instantiatedParams.language + '_' + instantiatedParams.voice,
        xWatsonLearningOptOut: true,
        timings: ['words']
      };
      const timings: [string, number, number][] = [];
      const voiceStream = tts.synthesizeUsingWebSocket(wsParams);
      promises.push(new Promise((resolve) => {
        voiceStream.on('end', () => {
          fs.writeFileSync(`${fullCachePath}_timings.json`, JSON.stringify(timings));
          resolve();
        });
      }));

      const writeStream = fs.createWriteStream(fullCachePath);
      promises.push(new Promise((resolve) => {
        writeStream.on('close', () => {
          console.log(`finished writing cache file: ${fullCachePath}`);
          resolve();
        });
      }));
      voiceStream.pipe(writeStream);
      voiceStream.on('words', (_, json) => {
        timings.push(...json.words);
      });
    }
    Promise.all(promises).then(() => {
      reply(fs.readFileSync(fullCachePath));
    });
  });
}

// load static sources
app.all('/', (_, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'X-Requested-With');
  next();
});

app.use(express.static(__dirname + '/../static'));
app.get('/', (_, res) => {
  res.render('index', {languages});
});

app.get('/index.js', (_, res) => {
  res.setHeader('Content-Type', 'script');
  res.sendFile(`${__dirname}/views/index.js`);
});

app.post('/', (req, res) => {
  synthesizeSpeech(req.body, (reply) => {
    res.json(reply);
  });
});

// do something when app is closing
process.on('exit', exitHandler);

// catches ctrl+c event
process.on('SIGINT', exitHandler);
process.on('SIGTERM', exitHandler);

// catches uncaught exceptions
process.on('uncaughtException', exceptionHandler);

createCache();
initialize().then(() => {
  app.listen();
}).catch((err) => {
  logger.error(`failed to initialize`);
  logger.error(`error thrown: ${err}`);
  process.exit(1);
});
