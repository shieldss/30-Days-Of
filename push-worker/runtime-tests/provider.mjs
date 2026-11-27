export default {
 async fetch(request){
  const url=new URL(request.url);
  if(url.hostname==='other.example')return new Response(null,{status:201}); // A redirect must not reach this path.
  const kind=url.pathname.split('/').at(-1);
  if(url.origin!=='https://fcm.googleapis.com'||request.method!=='POST'||
    !request.headers.get('Authorization')?.startsWith('vapid t='))
   return new Response(null,{status:400});
  if(kind==='daily-redirect')return Response.redirect('https://other.example/',302);
  if(!['daily','incomplete'].includes(kind)||
    request.headers.get('Topic')!=='thirty-days-'+kind||
    request.headers.get('Content-Encoding')!=='aes128gcm'||(await request.arrayBuffer()).byteLength<=86)
   return new Response(null,{status:400});
  return new Response(null,{status:201});
 }
};
