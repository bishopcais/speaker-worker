import {spawn, SpawnOptions, ChildProcess} from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import querystring from 'querystring';

import cislio from '@cisl/io';
import logger from '@cisl/logger';
import express from '@cisl/express';

import dotenv from 'dotenv';
import fetch from 'node-fetch';
import merge from 'lodash.merge';
import TextToSpeechV1 from 'ibm-watson/text-to-speech/v1';

import { cachePath, createCache, clearCache } from './cache';
import { BaiduOptions, BaiduCredentials, initializeBaidu } from './baidu';
import { getMacAddress } from './util';

interface SpeechParams {
  text: string;
  language?: string;
  lang?: string;
  voice?: string;
  volume?: number;
  pan?: number[];
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

let ffplayProc: ChildProcess;

const speaker_id = io.config.get('id') || 'speaker-worker';
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

dotenv.config({path: path.join(__dirname, '..', 'baidu-credentials.env')});

const baidu_credentials: BaiduCredentials = {
  client_id: process.env.BAIDU_CLIENT_ID,
  client_secret: process.env.BAIDU_CLIENT_SECRET
};

let baidu: BaiduOptions = {
  auth: "https://openapi.baidu.com/oauth/2.0/token?",
  url: "http://tsn.baidu.com/text2audio/",
  cuid: getMacAddress()
};

if (fs.existsSync('baidu.json')) {
  try {
    baidu = Object.assign(baidu, JSON.parse(fs.readFileSync('baidu.json', {encoding:'utf8'})));
  }
  catch {
    logger.error('Could not read or parse the baidu.json file');
    process.exit();
  }
}

// mapping of human-readable label to Baidu "Per" parameter
const baidu_voices: {[voice: string]: number} = {
  'Xiaomei': 0,
  'Xiaoyu': 1,
  'Happy': 3,
  'Ya': 4
};

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

  if (baidu_credentials.client_id && baidu_credentials.client_secret) {
    logger.info('getting baidu access token');
    languages['zh-CN'] = [];
    for (const voice in baidu_voices) {
      languages['zh-CN'].push(voice);
    }
    baidu = await initializeBaidu(baidu, baidu_credentials);
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

function playFile(file: string, volume: number, pan: number[], closeCallback: (exitCode: number) => void): void {
  let panString = '';
  if (Array.isArray(pan) && pan.length > 0) {
    panString = `,pan=${pan.length}c`;
    for (let i = 0; i < pan.length; i++) {
      panString += `|c${i}=${pan[i]}*c0`;
    }
  }

  const opts: SpawnOptions = {
    stdio: 'ignore',
    detached: false
  };

  // Use spawn here instead of exec as a separate process is created. Some
  // environments don't handle killing sub-shells very well, plus we don't
  // care about stdin/stdout/stderr
  ffplayProc = spawn('ffplay', ['-autoexit', '-nodisp', '-af', `volume=${volume}${panString}`, `${file}`], opts);
  ffplayProc.on('error', (err) => {
    logger.error(`Error spawning ffplay: ${err}`);
    closeCallback(1);
  });

  ffplayProc.on('close', closeCallback);
}

function synthesizeSpeech(params: InstantiatedSpeechParams, reply: (err: string | null, filePath?: string) => void): void {
  if (params.text === '') {
    logger.warn('Received empty string. Ignored.');
    return reply('text cannot be empty');
  }

  if (typeof params.text !== 'string') {
    logger.warn(`Received non-string: ${params.text}. Ignored.`);
    return reply('text must be a string');
  }

  if (!languages[params.language]) {
    logger.warn(`Invalid language used: ${params.language}.`);
    return reply('invalid language');
  }

  if (!languages[params.language].includes(params.voice)) {
    logger.warn(`Invalid voice used for ${params.language}: ${params.voice}`);
    return reply('invalid voice');
  }

  if (io.rabbit) {
    io.rabbit.publishTopic('speaker.speak.content', {
      text: params.text,
      time_captured: Date.now(),
      timestamp: params.timestamp,
      speaker: speaker_id,
      voice: params.voice,
      language: params.language
    });
  }

  const cacheKey = `${params.language}|${params.voice}|${params.text}`;
  const cacheKeyPath = crypto.createHash('sha1').update(cacheKey).digest('hex');
  const fullCachePath = path.join(cachePath, cacheKeyPath);

  if (!fs.existsSync(fullCachePath)) {
    if (params.language === 'zh-CN') {
      const query_params = {
        tex: params.text,
        lan: 'zh',
        cuid: baidu.cuid,
        ctp: 1,
        tok: baidu.access_token,
        per: baidu_voices[params.voice] || 0
      };
      fetch(baidu.url + `?${querystring.stringify(query_params)}`).then(resp => {
        const content_type = resp.headers.get('content-type');
        if (content_type) {
          return content_type.includes('application/json') ? resp.json() : resp.buffer();
        }
        throw new Error('response lacked valid content-type header');
      }).then((data) => {
        if (Buffer.isBuffer(data)) {
          fs.writeFileSync(fullCachePath, data);
          reply(null, fullCachePath);
        }
        else {
          logger.error(data);
          reply('failure to play');
        }
      });
    }
    else {
      const ws_params = {
        accept: 'audio/ogg;codecs=opus',
        text: params.text,
        voice: params.language + '_' + params.voice,
        xWatsonLearningOptOut: true,
        timings: ['words']
      };
      const timings: [string, number, number][] = [];
      const tempStream = tts.synthesizeUsingWebSocket(ws_params);
      tempStream.pipe(fs.createWriteStream(fullCachePath));
      tempStream.on('words', (_, json) => {
        timings.push(...json.words);
      });
      tempStream.on('close', () => {
        fs.writeFileSync(`${fullCachePath}_timings`, JSON.stringify(timings));
        reply(null, fullCachePath);
      });
    }
  }
  else {
    reply(null, fullCachePath);
  }
}

function playText(params: SpeechParams, reply: (message: object) => void): void {
  const instantiatedParams = getParameters(params);
  if (!params.text) {
    return reply({
      status: 'error',
      message: 'text parameter is missing'
    });
  }

  if (!reply) {
    reply = (): void => {
      return;
    };
  }

  synthesizeSpeech(instantiatedParams, (err, filePath) => {
    if (err) {
      return reply({
        status: 'error',
        message: err
      });
    }
    if (!filePath) {
      return reply({
        status: 'error',
        message: 'filepath not properly returned'
      });
    }

    if (fs.existsSync(`${filePath}_timings`)) {
      instantiatedParams.timings = JSON.parse(fs.readFileSync(`${filePath}_timings`, 'utf8'));
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

    playFile(filePath, instantiatedParams.volume, instantiatedParams.pan || [], (code) => {
      if (io.rabbit) {
        io.rabbit.publishTopic('speaker.speak.end', instantiatedParams);
      }
      if (code === 0) {
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
  });
}

function exitHandler(): void {
  if (ffplayProc) {
    ffplayProc.kill();
  }

  process.exit(0);
}

function exceptionHandler(err: Error): void {
  logger.error(`Caught exception:`);
  logger.error(`    ${err.stack}`);

  if (ffplayProc) {
    ffplayProc.kill();
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
    playText((request.content as SpeechParams), reply);
  });

  io.rabbit.onRpc('rpc-speaker-getSynthesizedSpeech', (request, reply) => {
    synthesizeSpeech(getParameters((request.content as SpeechParams)), (err, filePath) => {
      if (err) {
        return reply(err);
      }
      else if (!filePath) {
        return reply('invalid filePath returned');
      }
      reply(fs.readFileSync(filePath));
    });
  });

  io.rabbit.onRpc('rpc-speaker-playBuffer', (response, reply) => {
    const filePath = path.join(cachePath, `tmp-${io.generateUuid()}`);
    fs.writeFileSync(filePath, response.content);
    playFile(filePath, 1, [], (code) => {
      fs.unlinkSync(filePath);
      reply({
        status: code === 0 ? 'success' : 'error'
      });
    });
  });

  io.rabbit.onRpc('rpc-speaker-stop', (_, reply) => {
    if (ffplayProc) {
      ffplayProc.kill();
    }
    reply({
      status: 'success'
    });
  });
}

// load static sources
app.all('/', (req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'X-Requested-With');
  next();
});

app.use(express.static(__dirname + '/../static'));
app.get('/', (req, res) => {
  console.log(languages);
  res.render('index', {languages});
});

app.get('/index.js', (req, res) => {
  res.setHeader('Content-Type', 'script');
  res.sendFile(`${__dirname}/views/index.js`);
});

app.post('/', (req, res) => {
  playText(req.body, (msg: object) => {
    res.json(msg);
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
