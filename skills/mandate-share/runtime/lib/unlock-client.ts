export interface UnlockParameters { salt: string; iterations: number }

/** Included only in the password prompt. The stored verifier is never a browser parameter. */
export function unlockScript({ salt, iterations }: UnlockParameters, nonce?: string): string {
  if (typeof salt !== "string" || !/^[A-Za-z0-9_-]{22,86}$/u.test(salt) || salt.length % 4 === 1 ||
      !Number.isInteger(iterations) || iterations < 1_000 || iterations > 1_000_000) {
    throw new Error("Invalid browser unlock parameters");
  }
  const parameters = JSON.stringify({ salt, iterations });
  if (nonce !== undefined && !/^[A-Za-z0-9_-]{22}$/.test(nonce)) throw new Error("invalid unlock script nonce");
  return `<noscript><p>Enable JavaScript in your browser to unlock this page.</p></noscript><script${nonce ? ` nonce="${nonce}"` : ""}>
(function(parameters){
  var form=document.getElementById('mandate-share-unlock');
  if(!form)return;
  var password=form.querySelector('#password'),button=form.querySelector('button[type="submit"]'),challenge=form.querySelector('input[name="challenge"]');
  if(!password||!button||!challenge)return;
  password.removeAttribute('name');
  var status=document.createElement('p'),busy=false,ready=false;
  status.id='mandate-share-unlock-status';status.setAttribute('role','status');status.hidden=true;form.append(status);
  function message(text){status.textContent=text;status.hidden=!text;}
  function safeAction(){
    var target=new URL(form.getAttribute('action')||location.href,location.href);
    var transport=location.protocol==='https:'||(location.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(location.hostname));
    return transport&&target.origin===location.origin&&target.pathname===location.pathname;
  }
  function removeProof(){for(var input of form.querySelectorAll('input[name="proof"]')){input.value='';input.remove();}}
  form.addEventListener('submit',async function(event){
    event.preventDefault();
    if(busy||!ready)return;
    if(!form.reportValidity())return;
    var raw=password.value,bytes=new TextEncoder().encode(raw),controls=[];
    if(bytes.length>1024){bytes.fill(0);message('That password is too long.');return;}
    busy=true;password.disabled=true;button.disabled=true;form.setAttribute('aria-busy','true');message('Unlocking…');
    try{
      if(!safeAction())throw new Error();
      var salt=Uint8Array.from(atob(parameters.salt.replace(/-/g,'+').replace(/_/g,'/')),function(c){return c.charCodeAt(0);});
      var key=await crypto.subtle.importKey('raw',bytes,'PBKDF2',false,['deriveBits']);
      var result=new Uint8Array(await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt:salt,iterations:parameters.iterations},key,256));
      if(!safeAction())throw new Error();
      removeProof();
      var proof=document.createElement('input');proof.type='hidden';proof.name='proof';
      proof.value=btoa(String.fromCharCode.apply(null,result)).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');result.fill(0);form.append(proof);
      for(var control of form.elements){controls.push([control,control.disabled]);control.disabled=control!==proof&&control!==challenge;}
      password.removeAttribute('name');password.value='';form.method='post';form.enctype='application/x-www-form-urlencoded';
      HTMLFormElement.prototype.submit.call(form);
    }catch(_){
      removeProof();for(var saved of controls)saved[0].disabled=saved[1];
      password.value=raw;password.disabled=false;button.disabled=false;busy=false;form.removeAttribute('aria-busy');
      message('Could not unlock this page. Please try again.');password.focus();
    }finally{bytes.fill(0);}
  });
  try{ready=!!(globalThis.isSecureContext&&globalThis.crypto&&crypto.subtle&&crypto.subtle.importKey&&crypto.subtle.deriveBits&&globalThis.TextEncoder&&safeAction());}catch(_){}
  password.disabled=!ready;button.disabled=!ready;
  if(!ready)message('This browser cannot unlock this page. Open the link in a current browser over HTTPS.');
  addEventListener('pageshow',function(event){if(event.persisted){removeProof();busy=false;password.value='';password.disabled=!ready;button.disabled=!ready;form.removeAttribute('aria-busy');if(ready)message('');}});
})(${parameters});
</script>`;
}
