import {ChildProcess, spawn} from 'child_process';
import path from 'path';

import cislio from '@cisl/io';
import logger from '@cisl/logger';
import express from '@cisl/express';

import merge from 'lodash.merge';
import TextToSpeechV1 from 'ibm-watson/text-to-speech/v1';

import { createCache, clearCache } from './cache';

interface SpeechParams {
  text: string;
  language?: string;
  lang?: string;
  voice?: string;
  volume?: number;
  pan?: number[];
  stream?: boolean;
}


interface InstantiatedSpeechParams extends SpeechParams {
  language: string;
  voice: string;
  volume: number;
  pan: number[];
  timestamp: Date;
  timings?: string[];
}

interface SpeakerWorkerConfig {
  language: string;
  voices: {[language: string]: string};
  volume: number;
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

  streamProc = spawn('node', [path.resolve(__dirname, 'stream'), JSON.stringify(instantiatedParams)], {stdio: 'inherit'});
  streamProc.on('exit', (exitCode) => {
    if (io.rabbit) {
      io.rabbit.publishTopic('speaker.speak.end', instantiatedParams);
    }
    console.log(`exitCode: ${exitCode}`);
    if (exitCode === 0) {
      reply({
        status: 'success',
        data: instantiatedParams
      });
    }
    else {
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

  io.rabbit.onRpc('rpc-speaker-speakText', (request, reply) => {
    synthesizeSpeech(request.content as SpeechParams, reply);
  });

  io.rabbit.onRpc('rpc-speaker-stop', (_, reply) => {
    if (streamProc) {
      streamProc.kill();
    }
    reply({
      status: 'success'
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
