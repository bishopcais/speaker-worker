import wav from 'wav';
import Speaker from 'speaker';
// eslint-disable-next-line
// @ts-ignore
import Volume from 'pcm-volume';
import fs from 'fs';
import crypto from 'crypto';
import path from 'path';
import TextToSpeechV1 from 'ibm-watson/text-to-speech/v1';
import { cachePath } from './cache';

const tts = new TextToSpeechV1({});

const params = JSON.parse(process.argv[2]);
const fullCachePath = path.join(cachePath, params.cachePath);

const wavReader = new wav.Reader();
const volume = new Volume();
volume.setVolume(params.volume);

wavReader.on('format', (format) => {
  const speaker = new Speaker(format);

  wavReader.pipe(volume);
  volume.pipe(speaker);
});

let voiceStream;
if (fs.existsSync(fullCachePath)) {
  voiceStream = fs.createReadStream(fullCachePath);
}
else {
  const wsParams = {
    accept: 'audio/wav',
    text: params.text,
    voice: params.language + '_' + params.voice,
    xWatsonLearningOptOut: true,
    timings: ['words']
  };
  const cacheWriteStream = fs.createWriteStream(path.join(fullCachePath));
  const timings: [string, number, number][] = [];
  voiceStream = tts.synthesizeUsingWebSocket(wsParams);
  voiceStream.on('end', () => {
    fs.writeFileSync(`${fullCachePath}_timings.json`, JSON.stringify(timings));
  });
  voiceStream.pipe(fs.createWriteStream(fullCachePath));
  voiceStream.on('words', (_, json) => {
    timings.push(...json.words);
  });
  voiceStream.pipe(cacheWriteStream);
}

voiceStream.pipe(wavReader);
