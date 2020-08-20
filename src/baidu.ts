import { writeFileSync } from 'fs';
import { stringify } from 'querystring';
import fetch from 'node-fetch';

export interface BaiduCredentials {
  client_id?: string;
  client_secret?: string;
}

export interface BaiduOptions {
  auth: string;
  url: string;
  cuid: string;
  access_token?: string;
  session_token?: string;
  refresh_token?: string;
  expires_unix?: number;
  expires_in?: number;
}

export interface InstantiatedBaidu extends BaiduOptions {
  access_token: string;
  session_token: string;
  refresh_token: string;
  expires_unix: number;
  expires_in: number;
}

export interface BaiduResponse {
  access_token?: string;
  session_token: string;
  refresh_token: string;
  expires_unix: number;
}

export async function getToken(baidu: BaiduOptions, baidu_credentials: BaiduCredentials): Promise<BaiduResponse> {
  let query_string;
  if (baidu.session_token && baidu.refresh_token && baidu.expires_unix && Date.now() > baidu.expires_unix) {
    query_string = {
      grant_type: 'refresh_token',
      client_id: baidu_credentials.client_id,
      client_secret: baidu_credentials.client_secret,
      refresh_token: baidu.refresh_token
    };
  }
  else {
    query_string = {
      grant_type: 'client_credentials',
      client_id: baidu_credentials.client_id,
      client_secret: baidu_credentials.client_secret
    };
  }

  const resp = await fetch(baidu.auth + stringify(query_string));
  return await resp.json();
}

export async function initializeBaidu(baidu: BaiduOptions, baidu_credentials: BaiduCredentials): Promise<InstantiatedBaidu> {
  const token_json = await getToken(baidu, baidu_credentials);
  const final = (Object.assign(baidu, token_json) as InstantiatedBaidu);
  final.expires_unix = Date.now() + final.expires_in - 20;
  writeFileSync('baidu.json', JSON.stringify(final, null, 2));
  setTimeout(() => {
    getToken(baidu, baidu_credentials);
  }, final.expires_in);
  return final;
}
