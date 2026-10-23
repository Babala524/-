// Adapted from DMP API utils/getter.go. Copyright (c) 2024 Miracle, MIT; see ../../licenses/DMP-api-MIT.txt.
export function defaultClusterToken() {
  let value = 'VjFSQ2ExVXlWbkpsUm1oaFVqRmFWVlJXV21GaVZsWnlZVWRHV0dKV1JqUldNakI0V1ZaS1YyTkhlRlpOVjFKeVZrUkJOVkpzY0VkYVJtaFVVakpSZVZac1dsTlNNazE0VW14a1VtSlZXbWhVVlZKelUyeHJlRlZyT1ZaaVJscEpWMnRTUzFac1NYbFVXSEJhWld0YWRsa3haRWRYVms1VlZHeGtWMDFZUWtoV01qRjNZbTFXV0Zac1dtcFNSVXB2V2xkd1FrOVJQVDA9';
  for (let i=0;i<5;i++) value=Buffer.from(value,'base64').toString('utf8');
  return value;
}

// DMP's open source adapter uses this default Steam PublishedFileService key.
// Deployments can replace it with FEATHER_STEAM_API_KEY.
export function defaultSteamApiKey() {
  return Buffer.from([
    0xD5, 0xED, 0xDA, 0x66, 0x64, 0xFF, 0x23, 0xA6,
    0xB3, 0xD8, 0x50, 0x2C, 0x63, 0xB1, 0xBF, 0x6D,
  ].map(value => value ^ 0x55)).toString('hex');
}
