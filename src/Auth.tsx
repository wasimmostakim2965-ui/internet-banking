import { useEffect, useMemo, useState } from 'react';
import './account-opening.css';
import { supabase, supabaseConfigured } from './lib/supabase';
import {
  ensureLedgerAccount,
  loadKyc,
  loadProfile,
  loadSecurity,
  recordAudit,
  saveKyc,
  saveProfile,
  saveSecurity,
} from './lib/account';
import { passwordIssues } from './lib/security';
import QRCode from 'qrcode';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  FileCheck2,
  Lock,
  Shield,
  Smartphone,
} from 'lucide-react';

type SignupStep = 1 | 2 | 3 | 4 | 5 | 6 | 7;
type LoginStep = 'credentials' | 'email' | 'authenticator';

const GEO_API='https://countriesnow.space/api/v0.1';
const FALLBACK_COUNTRIES=['Bangladesh','United States','United Kingdom','United Arab Emirates','Canada','Australia','Germany','India','Singapore'];
type GeoState={name:string};
type GeoCountry={name:string;code:string;dial_code:string};

const STEP_TITLES: Record<SignupStep,string> = {
  1: 'Create your account',
  2: 'Verify your email',
  3: 'Personal details',
  4: 'Verify your identity',
  5: 'Where do you live?',
  6: 'Financial profile & security',
  7: 'Account created',
};

const b32='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const makeSecret=()=>{const bytes=crypto.getRandomValues(new Uint8Array(20));let out='',buf=0,bits=0;for(const b of bytes){buf=(buf<<8)|b;bits+=8;while(bits>=5){bits-=5;out+=b32[(buf>>bits)&31]}}if(bits)out+=b32[(buf<<(5-bits))&31];return out};
const decodeBase32=(value:string)=>{const clean=value.replace(/=+$/,'').toUpperCase();let buf=0,bits=0;const out:number[]=[];for(const c of clean){const n=b32.indexOf(c);if(n<0)throw new Error('Invalid authenticator secret');buf=(buf<<5)|n;bits+=5;if(bits>=8){bits-=8;out.push((buf>>bits)&255)}}return new Uint8Array(out)};
const hotp=async(secret:string,counter:number)=>{const key=await crypto.subtle.importKey('raw',decodeBase32(secret),{name:'HMAC',hash:'SHA-1'},false,['sign']);const data=new ArrayBuffer(8),view=new DataView(data);view.setUint32(0,Math.floor(counter/0x100000000));view.setUint32(4,counter>>>0);const digest=new Uint8Array(await crypto.subtle.sign('HMAC',key,data));const offset=digest[digest.length-1]&15;const n=((digest[offset]&127)<<24)|((digest[offset+1]&255)<<16)|((digest[offset+2]&255)<<8)|(digest[offset+3]&255);return String(n%1000000).padStart(6,'0')};
const validTotp=async(secret:string,code:string)=>{if(!/^\d{6}$/.test(code))return false;const counter=Math.floor(Date.now()/30000);for(const delta of [-1,0,1])if(await hotp(secret,counter+delta)===code)return true;return false};

export default function Auth({onBack,onSuccess,initialMode='signup',demoMode=false}:{onBack:()=>void;onSuccess:()=>void;initialMode?:'signup'|'signin';demoMode?:boolean}) {
  const [mode,setMode]=useState<'signup'|'signin'>(initialMode);
  const [step,setStep]=useState<SignupStep>(1);
  const [loginStep,setLoginStep]=useState<LoginStep>('credentials');
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  const [email,setEmail]=useState('');
  const [password,setPassword]=useState('');
  const [password2,setPassword2]=useState('');
  const [emailCode,setEmailCode]=useState('');
  const [authCode,setAuthCode]=useState('');
  const [fullName,setFullName]=useState('');
  const [firstName,setFirstName]=useState('');
  const [middleName,setMiddleName]=useState('');
  const [lastName,setLastName]=useState('');
  const [phone,setPhone]=useState('');
  const [legalName,setLegalName]=useState('');
  const [dob,setDob]=useState('');
  const [dobInput,setDobInput]=useState('');
  const [placeOfBirth,setPlaceOfBirth]=useState('');
  const [countryOfBirth,setCountryOfBirth]=useState('Bangladesh');
  const [secondaryNationality,setSecondaryNationality]=useState('');
  const [gender,setGender]=useState('');
  const [maritalStatus,setMaritalStatus]=useState('');
  const [nationality,setNationality]=useState('Bangladesh');
  const [occupation,setOccupation]=useState('');
  const [employer,setEmployer]=useState('');
  const [documentType,setDocumentType]=useState('National ID');
  const [documentNumber,setDocumentNumber]=useState('');
  const [documentCountry,setDocumentCountry]=useState('Bangladesh');
  const [address,setAddress]=useState('');
  const [city,setCity]=useState('');
  const [region,setRegion]=useState('');
  const [postal,setPostal]=useState('');
  const [taxResidence,setTaxResidence]=useState('Bangladesh');
  const [employmentStatus,setEmploymentStatus]=useState('');
  const [sourceOfFunds,setSourceOfFunds]=useState('');
  const [expectedMonthlyVolume,setExpectedMonthlyVolume]=useState('');
  const [bankCountry,setBankCountry]=useState('Bangladesh');
  const [bankName,setBankName]=useState('');
  const [bankAccountHolder,setBankAccountHolder]=useState('');
  const [bankAccountNumber,setBankAccountNumber]=useState('');
  const [bankIban,setBankIban]=useState('');
  const [bankSwiftBic,setBankSwiftBic]=useState('');
  const [userId,setUserId]=useState<string|null>(null);
  const [mfaSecret,setMfaSecret]=useState('');
  const [mfaQr,setMfaQr]=useState('');
  const [mfaCode,setMfaCode]=useState('');
  const [loginMfaSecret,setLoginMfaSecret]=useState('');
  const [loginUserId,setLoginUserId]=useState<string|null>(null);
  const [googleSignup,setGoogleSignup]=useState(false);
  const [geoCountries,setGeoCountries]=useState<GeoCountry[]>([]);
  const [dialCodes,setDialCodes]=useState<Record<string,string>>({});
  const [states,setStates]=useState<GeoState[]>([]);
  const [cities,setCities]=useState<string[]>([]);
  const [geoLoading,setGeoLoading]=useState(false);
  const [cityLoading,setCityLoading]=useState(false);
  const formatDob=(iso:string)=>{if(!iso)return '';const [y,m,d]=iso.split('-');return y&&m&&d?d+'/'+m+'/'+y:''};
  const handleDob=(value:string)=>{const digits=value.replace(/\D/g,'').slice(0,8);let out=digits.slice(0,2);if(digits.length>2)out+='/'+digits.slice(2,4);if(digits.length>4)out+='/'+digits.slice(4,8);setDobInput(out);if(/^\d{2}\/\d{2}\/\d{4}$/.test(out)){const [d,m,y]=out.split('/');setDob(y+'-'+m+'-'+d)}else setDob('')};
  const passwordProblems=useMemo(()=>passwordIssues(password),[password]);

  useEffect(()=>{if(demoMode){setEmail('TEST');setPassword('TEST');setPassword2('TEST');setEmailCode('TEST');setAuthCode('TEST');setFullName('TEST');setPhone('TEST');setLegalName('TEST');setDob('2000-01-01');setNationality('TEST');setOccupation('TEST');setDocumentType('TEST');setDocumentNumber('TEST');setDocumentCountry('TEST');setAddress('TEST');setCity('TEST');setRegion('TEST');setPostal('TEST');setTaxResidence('TEST');setMfaCode('TEST');setStep(1);return;} void (async()=>{const {data}=await supabase.auth.getSession();if(data.session?.user){const user=data.session.user;setUserId(user.id);setEmail(user.email??'');const profile=await loadProfile(user.id).catch(()=>null);const kyc=await loadKyc(user.id).catch(()=>null);if(kyc){setDob(kyc.date_of_birth??'');setDobInput(kyc.date_of_birth?formatDob(kyc.date_of_birth):'');setNationality(kyc.nationality??'Bangladesh');setOccupation(kyc.occupation??'');setLegalName(kyc.legal_name??'');setAddress(kyc.address_line1??'');setCity(kyc.city??'');setRegion(kyc.region??'');setPostal(kyc.postal_code??'');setTaxResidence(kyc.tax_residence??'');setDocumentType(kyc.document_type??'National ID');setDocumentNumber(kyc.document_number??'');setDocumentCountry(kyc.document_country??'Bangladesh');setFirstName(kyc.first_name??'');setMiddleName(kyc.middle_name??'');setLastName(kyc.last_name??'');setPlaceOfBirth(kyc.place_of_birth??'');setCountryOfBirth(kyc.country_of_birth??kyc.nationality??'Bangladesh');setSecondaryNationality(kyc.secondary_nationality??'');setGender(kyc.gender??'');setMaritalStatus(kyc.marital_status??'');setEmployer(kyc.employer??'');setEmploymentStatus(kyc.employment_status??'');setSourceOfFunds(kyc.source_of_funds??'');setExpectedMonthlyVolume(kyc.expected_monthly_volume??'');setBankCountry(kyc.bank_country??'Bangladesh');setBankName(kyc.bank_name??'');setBankAccountHolder(kyc.bank_account_holder??'');setBankAccountNumber(kyc.bank_account_number??'');setBankIban(kyc.bank_iban??'');setBankSwiftBic(kyc.bank_swift_bic??'');}const pendingLocal=window.localStorage.getItem('paywai_google_signup')==='1';const providerGoogle=(user.app_metadata?.providers??[]).includes('google');const googleFlow=pendingLocal||user.user_metadata?.paywai_signup_method==='google'||providerGoogle;if(pendingLocal)window.localStorage.removeItem('paywai_google_signup');if(googleFlow){const resumeStep=(profile?.onboarding_step??2) as SignupStep;if(resumeStep>=7){onSuccess();return}setGoogleSignup(true);const name=user.user_metadata?.full_name??user.user_metadata?.name??'';if(name){const parts=name.trim().split(/\\s+/);setFirstName(parts[0]??'');setLastName(parts.length>1?parts[parts.length-1]:'');setMiddleName(parts.length>2?parts.slice(1,-1).join(' '):'');setFullName(name);setLegalName(name);}setStep(resumeStep<2?2:resumeStep);if(!profile||resumeStep<2)await saveProfile(user.id,{onboarding_step:2});if(user.user_metadata?.paywai_signup_method!=='google')await supabase.auth.updateUser({data:{paywai_signup_method:'google'}}).catch(()=>undefined);}}})().catch(()=>undefined);},[]);

  useEffect(()=>{void (async()=>{
    try{
      const res=await fetch(`${GEO_API}/countries/codes`);
      const json=await res.json();
      const rows=Array.isArray(json?.data)?json.data:[];
      const normalized=rows.map((x:any)=>({name:String(x.name).trim(),code:String(x.code).trim().toUpperCase(),dial_code:String(x.dial_code).trim()})).filter((x:GeoCountry)=>x.name&&x.code);
      setGeoCountries(normalized);
      setDialCodes(Object.fromEntries(normalized.map((x:GeoCountry)=>[x.name,x.dial_code])));
      if(normalized.length && !normalized.some((x:GeoCountry)=>x.name===nationality))setNationality(normalized.find((x:GeoCountry)=>x.code==='BD')?.name??normalized[0].name);
    }catch{
      setGeoCountries(FALLBACK_COUNTRIES.map(name=>({name,code:'',dial_code:''})));
    }
  })()},[]);

  useEffect(()=>{void (async()=>{
    if(!nationality){setStates([]);setCities([]);return}
    setGeoLoading(true);setStates([]);setCities([]);setRegion('');setCity('');
    try{
      const res=await fetch(`${GEO_API}/countries/states/q?country=${encodeURIComponent(nationality)}`);
      const json=await res.json();
      const rows=Array.isArray(json?.data?.states)?json.data.states:[];
      setStates(rows.map((x:any)=>({name:String(x.name).trim()})).filter((x:GeoState)=>x.name));
    }catch{setStates([])}
    finally{setGeoLoading(false)}
  })()},[nationality]);

  useEffect(()=>{void (async()=>{
    if(!nationality||!region){setCities([]);return}
    setCityLoading(true);setCities([]);
    try{
      const res=await fetch(`${GEO_API}/countries/state/cities`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({country:nationality,state:region})});
      const json=await res.json();
      const rows=Array.isArray(json?.data)?json.data:[];
      setCities(rows.map((x:any)=>String(typeof x==='string'?x:x.name??'').trim()).filter(Boolean));
    }catch{setCities([])}
    finally{setCityLoading(false)}
  })()},[nationality,region]);

  const go=(next:SignupStep)=>{setError('');setNotice('');setStep(next);if(userId&&!demoMode)void saveProfile(userId,{onboarding_step:next}).catch(()=>undefined);window.scrollTo({top:0,behavior:'smooth'})};

  const startGoogleSignup=async()=>{if(!supabaseConfigured){setError('Account creation is not configured on this deployment yet.');return}setBusy(true);setError('');window.localStorage.setItem('paywai_google_signup','1');const {error:e}=await supabase.auth.signInWithOAuth({provider:'google',options:{redirectTo:window.location.origin}});if(e){window.localStorage.removeItem('paywai_google_signup');setBusy(false);setError(e.message)}};

  const sendSignupCode=async()=>{const {error:e}=await supabase.auth.resend({type:'signup',email:email.trim()});if(e)throw e};

  const completeGooglePassword=async()=>{if(!userId){setError('Your Google sign-in session could not be found. Please start again.');return}if(passwordProblems.length){setError(`Your password needs ${passwordProblems.join(', ')}.`);return}if(password!==password2){setError('The two passwords do not match.');return}setBusy(true);setError('');const {error:e}=await supabase.auth.updateUser({password});if(e){setBusy(false);setError(e.message);return}setBusy(false);go(3);void recordAudit(userId,'onboarding.google_password_set','auth').catch(()=>undefined)};

  const createAccount=async()=>{
    if(demoMode){go(2);return}
    if(!supabaseConfigured){setError('Account creation is not configured on this deployment yet.');return}
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){setError('Enter a valid email address.');return}
    if(passwordProblems.length){setError(`Your password needs ${passwordProblems.join(', ')}.`);return}
    if(password!==password2){setError('The two passwords do not match.');return}
    setBusy(true);setError('');
    const {data,error:e}=await supabase.auth.signUp({email:email.trim(),password,options:{data:{country:'Bangladesh',account_type:'personal'},emailRedirectTo:window.location.origin}});
    if(e){setBusy(false);setError(e.message.toLowerCase().includes('already')?'An account already exists for this email. Sign in instead.':e.message);return}
    if(!data.user){setBusy(false);setError('We could not create the account. Please try again.');return}
    setUserId(data.user.id);setEmail(data.user.email??email.trim());
    go(2);
    setBusy(false);
  };

  const verifySignupEmail=async()=>{
    if(!/^\d{6,8}$/.test(emailCode.trim())){setError('Enter the verification code from your email.');return}
    setBusy(true);setError('');
    const {data,error:e}=await supabase.auth.verifyOtp({email:email.trim(),token:emailCode.trim(),type:'email'});
    if(e){setBusy(false);setError('That verification code is incorrect or expired.');return}
    if(data.user)setUserId(data.user.id);
    setBusy(false);go(3);
  };

  const resendSignupCode=async()=>{setBusy(true);setError('');try{await sendSignupCode();setNotice('A new verification code has been sent to your email.');}catch(e){setError((e as Error).message||'Could not send a new code.');}finally{setBusy(false)}};

  const persistDetails=async()=>{
    if(demoMode){go(4);return}
    if(!userId||!firstName.trim()||!lastName.trim()){setError('Enter your first and last legal name.');return}
    if(!/^\+?[\d\s()-]{7,}$/.test(phone.trim())){setError('Enter a valid mobile number including the country code.');return}
    if(!/^\d{2}\/\d{2}\/\d{4}$/.test(dobInput)||!dob){setError('Enter your date of birth as DD/MM/YYYY.');return}
    
    if(!gender||!maritalStatus){setError('Select your gender and marital status.');return}
    setBusy(true);setError('');
    try{const composed=[firstName.trim(),middleName.trim(),lastName.trim()].filter(Boolean).join(' ');setFullName(composed);await saveProfile(userId,{account_type:'personal',country:null,full_name:composed,phone:phone.trim(),business_name:null,business_type:null,business_category:null,onboarding_status:'details_pending'});await saveKyc(userId,{legal_name:composed,first_name:firstName.trim(),middle_name:middleName.trim()||null,last_name:lastName.trim(),date_of_birth:dob,place_of_birth:null,country_of_birth:null,secondary_nationality:null,gender,marital_status,nationality:null,occupation:occupation.trim()||null,employer:employer.trim()||null});await recordAudit(userId,'onboarding.details_saved','profile');go(4)}catch(e){setError((e as Error).message||'We could not save your personal details.')}finally{setBusy(false)}
  };

  const persistIdentity=async()=>{
    if(demoMode){go(5);return}
    if(!userId||!documentNumber.trim()){setError('Document number is required.');return}
    setBusy(true);setError('');
    try{await saveKyc(userId,{legal_name:fullName.trim(),date_of_birth:dob,nationality,document_type:documentType,document_number:documentNumber.trim(),document_country:documentCountry,status:'draft'});await saveProfile(userId,{onboarding_status:'kyc_pending'});await recordAudit(userId,'onboarding.identity_saved','kyc_application');go(5)}catch(e){setError((e as Error).message||'We could not save your identity details.')}finally{setBusy(false)}
  };

  const persistResidence=async()=>{
    if(demoMode){go(6);return}
    if(!userId||!address.trim()||!city.trim()||!postal.trim()){setError('Street address, city and postal code are required.');return}
    setBusy(true);setError('');
    try{await saveKyc(userId,{address_line1:address.trim(),city:city.trim(),region:region.trim(),postal_code:postal.trim(),tax_residence:null});await recordAudit(userId,'onboarding.residence_saved','kyc_application');await setupAuthenticator();go(6)}catch(e){setError((e as Error).message||'We could not save your address.')}finally{setBusy(false)}
  };

  const persistFinancialProfile=async()=>{if(!userId)return false;if(!employmentStatus||!sourceOfFunds||!expectedMonthlyVolume){setError('Complete your employment, source of funds and expected transaction volume.');return false}try{await saveKyc(userId,{employment_status:employmentStatus,source_of_funds:sourceOfFunds,expected_monthly_volume:expectedMonthlyVolume,bank_country:bankCountry,bank_name:bankName.trim()||null,bank_account_holder:bankAccountHolder.trim()||null,bank_account_number:bankAccountNumber.trim()||null,bank_iban:bankIban.trim()||null,bank_swift_bic:bankSwiftBic.trim()||null});return true}catch(e){setError((e as Error).message||'We could not save your financial profile.');return false}};

  const setupAuthenticator=async()=>{
    if(!userId)return;
    const secret=makeSecret();
    const issuer='Paywai';
    const label=`Paywai:${email.trim()}`;
    const uri=`otpauth://totp/${encodeURIComponent(label)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
    const qr=await QRCode.toDataURL(uri,{width:220,margin:1});
    setMfaSecret(secret);setMfaQr(qr);setMfaCode('');
  };

  const verifyAuthenticator=async()=>{
    if(demoMode){go(7);return}
    if(!userId||!mfaSecret){setError('Generate the authenticator setup first.');return}
    setBusy(true);setError('');
    try{if(!(await persistFinancialProfile())){setBusy(false);return}if(!(await validTotp(mfaSecret,mfaCode.trim())))throw new Error('That authenticator code is incorrect or expired.');await saveSecurity(userId,{mfa_secret:mfaSecret,mfa_enabled:true});await recordAudit(userId,'security.mfa_enabled','security_settings');await finishAccount(true)}catch(e){setError((e as Error).message||'Could not enable the authenticator.')}finally{setBusy(false)}
  };

  const skipAuthenticator=async()=>{if(demoMode){go(7);return}if(!userId)return;setBusy(true);setError('');try{if(!(await persistFinancialProfile())){setBusy(false);return}await saveSecurity(userId,{mfa_secret:null,mfa_enabled:false});await recordAudit(userId,'security.mfa_skipped','security_settings');await finishAccount(false)}catch(e){setError((e as Error).message||'Could not finish account setup.')}finally{setBusy(false)}};

  const finishAccount=async(mfa:boolean)=>{
    if(!userId)return;
    await saveKyc(userId,{status:'submitted',submitted_at:new Date().toISOString()});
    await saveProfile(userId,{onboarding_status:'submitted'});
    await ensureLedgerAccount(userId,'USD');
    await recordAudit(userId,'onboarding.submitted','kyc_application',userId,{mfaEnabled:mfa});
    go(7);
  };

  const startLogin=async()=>{
    if(!email.trim()||!password){setError('Enter your email address and password.');return}
    setBusy(true);setError('');
    const {data,error:e}=await supabase.auth.signInWithPassword({email:email.trim(),password});
    if(e){setBusy(false);setError(e.message.toLowerCase().includes('not confirmed')?'Verify your email address first.':'That email and password combination is not correct.');return}
    if(!data.user){setBusy(false);setError('Sign in could not be completed.');return}
    const id=data.user.id;setLoginUserId(id);
    const security=await loadSecurity(id).catch(()=>null);
    await supabase.auth.signOut();
    try{const {error:otpError}=await supabase.auth.signInWithOtp({email:email.trim(),options:{shouldCreateUser:false}});if(otpError)throw otpError}catch(e){setBusy(false);setError((e as Error).message||'We could not send your email verification code.');return}
    setLoginMfaSecret(security?.mfa_enabled&&security.mfa_secret?security.mfa_secret:'');
    setLoginStep('email');setBusy(false);
  };

  const verifyLoginEmail=async()=>{
    if(!/^\d{6,8}$/.test(emailCode.trim())){setError('Enter the verification code from your email.');return}
    if(!loginUserId){setError('Your login session expired. Start again.');return}
    setBusy(true);setError('');
    const {data,error:e}=await supabase.auth.verifyOtp({email:email.trim(),token:emailCode.trim(),type:'email'});
    if(e){setBusy(false);setError('That verification code is incorrect or expired.');return}
    if(!data.user){setBusy(false);setError('Email verification did not complete.');return}
    if(loginMfaSecret){setLoginStep('authenticator');setBusy(false);return}
    onSuccess();
  };

  const verifyLoginAuthenticator=async()=>{
    if(!loginMfaSecret){onSuccess();return}
    setBusy(true);setError('');
    if(!(await validTotp(loginMfaSecret,authCode.trim()))){setBusy(false);setError('That authenticator code is incorrect or expired.');return}
    await recordAudit(loginUserId??'', 'auth.mfa_verified','security_settings',loginUserId??undefined);
    setBusy(false);onSuccess();
  };

  const resendLoginCode=async()=>{setBusy(true);setError('');try{const {error:e}=await supabase.auth.signInWithOtp({email:email.trim(),options:{shouldCreateUser:false}});if(e)throw e;setNotice('A new verification code has been sent.')}catch(e){setError((e as Error).message||'Could not send a new code.')}finally{setBusy(false)}};

  const back=()=>{if(step===1){setGoogleSignup(false);setNotice('');setError('');return onBack();}if(step===2)return go(1);if(step===3)return go(1);if(step===4)return go(3);if(step===5)return go(4);if(step===6)return go(5);return go(1)};

  if(mode==='signin')return <AuthShell onBack={onBack} title={loginStep==='credentials'?'Welcome back':loginStep==='email'?'Verify your email':'Authenticator verification'} kicker="SIGN IN TO PAYWAI" step={loginStep==='credentials'?'01 / 03':loginStep==='email'?'02 / 03':'03 / 03'}>
    {loginStep==='credentials'&&<Panel title="Email and password" text="Enter your Paywai email and password first. We will then send a one-time code to your email."><Field label="Email address"><input type="email" autoComplete="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="you@example.com"/></Field><Field label="Password"><input type="password" autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)} placeholder="Your password"/></Field>{error&&<div className="error-note">{error}</div>}<button className="primary auth-submit" onClick={startLogin} disabled={busy}>{busy?'Checking…':'Continue'} <ArrowRight size={15}/></button></Panel>}
    {loginStep==='email'&&<Panel title="Enter your email code" text={`We sent a verification code to ${email}. Enter it here to continue.`}><Field label="Email verification code"><input className="otp-input" inputMode="numeric" maxLength={8} value={emailCode} onChange={e=>setEmailCode(e.target.value.replace(/\D/g,''))} placeholder="123456"/></Field>{notice&&<div className="success-note">{notice}</div>}{error&&<div className="error-note">{error}</div>}<button className="primary auth-submit" onClick={verifyLoginEmail} disabled={busy}>{busy?'Verifying…':'Verify email'} <ArrowRight size={15}/></button><button className="resend" onClick={resendLoginCode} disabled={busy}>Send a new code</button></Panel>}
    {loginStep==='authenticator'&&<Panel title="Enter your authenticator code" text="Open Google Authenticator or your chosen authenticator app and enter the current 6-digit code."><Field label="Authenticator code"><input className="otp-input" inputMode="numeric" maxLength={6} value={authCode} onChange={e=>setAuthCode(e.target.value.replace(/\D/g,''))} placeholder="000000"/></Field>{error&&<div className="error-note">{error}</div>}<button className="primary auth-submit" onClick={verifyLoginAuthenticator} disabled={busy}>{busy?'Verifying…':'Verify and sign in'} <Check size={15}/></button></Panel>}
    <AuthFooter onBack={onBack} onSignup={()=>{setError('');setLoginStep('credentials');setMode('signup');setStep(1)}}/>
  </AuthShell>;

  if(step===7)return <AuthShell onBack={onBack} title="Your account was created successfully" kicker="PAYWAI ACCOUNT READY" step="07 / 07"><Panel title="Account successfully created" text="Your Paywai account has been created. You can now go to your dashboard."><button className="primary auth-submit" onClick={onSuccess}>Go to dashboard <ArrowRight size={15}/></button></Panel><div className="onboarding-foot">Your security settings are saved to your account.</div></AuthShell>;

  return <AuthShell onBack={onBack} title={step===2&&googleSignup?'Secure your Paywai account':STEP_TITLES[step]} kicker="OPEN A PAYWAI ACCOUNT" step={`${String(step).padStart(2,'0')} / 07`}>
    <div className="progress-track"><i style={{width:`${(step/7)*100}%`}}/></div>
    {step===1&&<Panel title="Create your account" text="Choose Google or continue manually with your email address and password."><button type="button" className="google-button" onClick={startGoogleSignup} disabled={busy}><span className="google-mark">G</span><span>Continue with Google</span></button><div className="auth-divider"><span>OR</span></div><Field label="Email address"><input type="email" autoComplete="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="you@example.com"/></Field><Field label="Password"><input type="password" autoComplete="new-password" value={password} onChange={e=>setPassword(e.target.value)} placeholder="Create a password"/></Field><Field label="Confirm password"><input type="password" autoComplete="new-password" value={password2} onChange={e=>setPassword2(e.target.value)} placeholder="Repeat your password"/></Field><div className="notice"><span>At least 8 characters with an uppercase letter, a lowercase letter and a number.</span></div>{error&&<div className="error-note">{error}</div>}<Actions back={onBack} next={createAccount} busy={busy} label="Create account"/></Panel>}
    {step===2&&googleSignup&&<Panel title="Set your Paywai password" text="This password will be required for Paywai sign-in and sensitive account actions."><Field label="Google email"><input type="email" value={email} readOnly aria-readonly="true"/></Field><Field label="Paywai password"><input type="password" autoComplete="new-password" value={password} onChange={e=>setPassword(e.target.value)} placeholder="Create your password"/></Field><Field label="Confirm password"><input type="password" autoComplete="new-password" value={password2} onChange={e=>setPassword2(e.target.value)} placeholder="Confirm your password"/></Field>{error&&<div className="error-note">{error}</div>}<Actions back={()=>go(1)} next={completeGooglePassword} busy={busy} label="Continue"/></Panel>}
    {step===2&&!googleSignup&&<Panel title="Verify your email" text={`We sent a one-time verification code to ${email}. Enter the code here; no confirmation link is required.`}><Field label="Email verification code"><input className="otp-input" inputMode="numeric" maxLength={8} value={emailCode} onChange={e=>setEmailCode(e.target.value.replace(/\D/g,''))} placeholder="123456"/></Field>{notice&&<div className="success-note">{notice}</div>}{error&&<div className="error-note">{error}</div>}<button className="primary auth-submit" onClick={verifySignupEmail} disabled={busy}>{busy?'Verifying…':'Verify email'} <ArrowRight size={15}/></button><button className="resend" onClick={resendSignupCode} disabled={busy}>Send a new code</button></Panel>}
    {step===3&&<Panel title="Personal details" text="Provide your legal personal information exactly as shown on your official records."><div className="form-grid"><Field label="First name"><input value={firstName} onChange={e=>setFirstName(e.target.value)} placeholder="First name" autoComplete="given-name"/></Field><Field label="Middle name (optional)"><input value={middleName} onChange={e=>setMiddleName(e.target.value)} placeholder="Middle name" autoComplete="additional-name"/></Field><Field label="Last name"><input value={lastName} onChange={e=>setLastName(e.target.value)} placeholder="Last name" autoComplete="family-name"/></Field><Field label="Date of birth"><input type="text" inputMode="numeric" maxLength={10} value={dobInput} onChange={e=>handleDob(e.target.value)} placeholder="DD/MM/YYYY" autoComplete="bday"/></Field><Field label="Gender"><select value={gender} onChange={e=>setGender(e.target.value)}><option value="">Select</option><option>Male</option><option>Female</option><option>Non-binary</option><option>Prefer not to say</option></select></Field><Field label="Marital status"><select value={maritalStatus} onChange={e=>setMaritalStatus(e.target.value)}><option value="">Select</option><option>Single</option><option>Married</option><option>Divorced</option><option>Widowed</option><option>Separated</option></select></Field><Field label="Occupation or profession"><input value={occupation} onChange={e=>setOccupation(e.target.value)} placeholder="Occupation or profession" autoComplete="organization-title"/></Field><Field label="Employer (optional)"><input value={employer} onChange={e=>setEmployer(e.target.value)} placeholder="Employer or company" autoComplete="organization"/></Field></div><Field label="Mobile number"><input value={phone} onChange={e=>setPhone(e.target.value.replace(/[^0-9+\s()-]/g,''))} placeholder="+880 1XXX XXXXXX" autoComplete="tel" inputMode="tel"/></Field><Field label="Email address"><input type="email" value={email} readOnly aria-readonly="true" autoComplete="email"/></Field><div className="notice"><span>Your personal information is used for identity, compliance and account verification.</span></div>{error&&<div className="error-note">{error}</div>}<Actions back={()=>go(1)} next={persistDetails} busy={busy} label="Continue"/></Panel>}
    {step===4&&<Panel title="Identity document" text="Verify your identity with a valid government-issued document."><div className="form-grid"><Field label="Document type"><select value={documentType} onChange={e=>setDocumentType(e.target.value)}>{demoMode&&<option>TEST</option>}<option>National ID</option><option>Passport</option><option>Driver's license</option></select></Field><Field label="Document country"><select value={documentCountry} onChange={e=>setDocumentCountry(e.target.value)}>{(geoCountries.length?geoCountries.map(c=>c.name):FALLBACK_COUNTRIES).map(c=><option key={c}>{c}</option>)}</select></Field></div><Field label="Document number"><input value={documentNumber} onChange={e=>setDocumentNumber(e.target.value)} placeholder="Enter the number on the document"/></Field><div className="notice"><span>Your document details are used for identity verification and compliance review.</span></div>{error&&<div className="error-note">{error}</div>}<Actions back={()=>go(3)} next={persistIdentity} busy={busy} label="Continue"/></Panel>}
    {step===5&&<Panel title="Residential address" text="Provide the address where you currently live."><Field label="Street address"><input value={address} onChange={e=>setAddress(e.target.value)} placeholder="House, street and area"/></Field><div className="form-grid"><Field label="State / province / division"><input value={region} onChange={e=>setRegion(e.target.value)} placeholder="State, province or division"/></Field><Field label="City"><input value={city} onChange={e=>setCity(e.target.value)} placeholder="City"/> </Field><Field label="Postal code"><input value={postal} onChange={e=>setPostal(e.target.value)} placeholder="Postal code"/></Field></div>{error&&<div className="error-note">{error}</div>}<Actions back={()=>go(4)} next={persistResidence} busy={busy} label="Continue"/></Panel>}
    {step===6&&<Panel title="Financial profile & account security" text="Tell us how you expect to use Paywai, then secure the account with an authenticator app."><div className="form-grid"><Field label="Employment status"><select value={employmentStatus} onChange={e=>setEmploymentStatus(e.target.value)}><option value="">Select</option><option>Employed</option><option>Self-employed</option><option>Business owner</option><option>Student</option><option>Retired</option><option>Unemployed</option><option>Other</option></select></Field><Field label="Source of funds"><select value={sourceOfFunds} onChange={e=>setSourceOfFunds(e.target.value)}><option value="">Select</option><option>Salary</option><option>Business income</option><option>Freelance income</option><option>Investments</option><option>Savings</option><option>Family support</option><option>Other</option></select></Field><Field label="Expected monthly transaction volume"><select value={expectedMonthlyVolume} onChange={e=>setExpectedMonthlyVolume(e.target.value)}><option value="">Select</option><option>Under $1,000</option><option>$1,000–$5,000</option><option>$5,000–$25,000</option><option>$25,000–$100,000</option><option>Over $100,000</option></select></Field><Field label="Bank country (optional)"><select value={bankCountry} onChange={e=>setBankCountry(e.target.value)}>{(geoCountries.length?geoCountries.map(c=>c.name):FALLBACK_COUNTRIES).map(c=><option key={c}>{c}</option>)}</select></Field></div><Field label="Bank name (optional)"><input value={bankName} onChange={e=>setBankName(e.target.value)} placeholder="Bank name"/></Field><div className="form-grid"><Field label="Account holder name (optional)"><input value={bankAccountHolder} onChange={e=>setBankAccountHolder(e.target.value)} placeholder="Account holder name"/></Field><Field label="Account number (optional)"><input value={bankAccountNumber} onChange={e=>setBankAccountNumber(e.target.value)} placeholder="Account number"/></Field><Field label="IBAN (optional)"><input value={bankIban} onChange={e=>setBankIban(e.target.value)} placeholder="IBAN, if applicable"/></Field><Field label="SWIFT / BIC (optional)"><input value={bankSwiftBic} onChange={e=>setBankSwiftBic(e.target.value)} placeholder="SWIFT / BIC"/></Field></div><div className="mfa-setup">{mfaQr&&<img className="mfa-qr" src={mfaQr} alt="Authenticator setup QR code"/>}<div className="mfa-secret"><span>Manual setup key</span><strong>{mfaSecret}</strong></div><Field label="6-digit authenticator code"><input className="otp-input" inputMode="numeric" maxLength={6} value={mfaCode} onChange={e=>setMfaCode(e.target.value.replace(/\D/g,''))} placeholder="000000"/></Field></div>{error&&<div className="error-note">{error}</div>}<div className="onboarding-actions"><button className="secondary" onClick={skipAuthenticator} disabled={busy}>Skip for now</button><button className="primary" onClick={verifyAuthenticator} disabled={busy}>Continue <Check size={15}/></button></div><div className="notice"><span>If you skip, you can set up your authenticator later from the dashboard security settings.</span></div></Panel>}
    <div className="onboarding-foot">Paywai staff will never ask you for your password or a login code.</div>
  </AuthShell>;
}

function AuthShell({children,onBack,title,kicker,step}:{children:React.ReactNode;onBack:()=>void;title:string;kicker:string;step:string}){return <div className="auth-page onboarding-page"><div className="auth-side onboarding-side"><button className="brand" onClick={onBack}><span className="brand-mark"><Shield size={17}/></span><span><span className="brand-name light">PAYWAI</span><span className="brand-sub light">PRIVATE FINANCIAL INFRASTRUCTURE</span></span></button><div className="onboarding-side-copy"><div className="eyebrow pale">SECURE ACCOUNT ACCESS</div><h1>Your money. <em>One clear view.</em></h1><p>Protect your account with email verification and optional authenticator-based security.</p><div className="onboarding-assurance"><div><Shield size={16}/><span><b>Protected sign-in</b><small>Email verification before access</small></span></div><div><Lock size={16}/><span><b>Authenticator ready</b><small>Optional additional sign-in protection</small></span></div></div></div></div><div className="auth-form-wrap"><div className="onboarding-form"><div className="mobile-auth-logo"><button className="brand" onClick={onBack}><span className="brand-mark"><Shield size={17}/></span><span><span className="brand-name">PAYWAI</span><span className="brand-sub">PRIVATE FINANCIAL INFRASTRUCTURE</span></span></button></div><div className="onboarding-head"><div><div className="auth-kicker">{kicker}</div><h2>{title}</h2></div><span className="step-count">{step}</span></div>{children}</div></div></div>}

function Panel({children,title,text}:{children:React.ReactNode;title:string;text:string}){return <div className="verification-panel"><b>{title}</b><p>{text}</p>{children}</div>}
function Field({label,children}:{label:string;children:React.ReactNode}){return <label>{label}{children}</label>}
function Actions({back,next,busy,label}:{back:()=>void;next:()=>void;busy:boolean;label:string}){return <div className="onboarding-actions"><button className="secondary" onClick={back} disabled={busy}>Back</button><button className="primary" onClick={next} disabled={busy}>{label} <ArrowRight size={15}/></button></div>}
function AuthFooter({onBack,onSignup}:{onBack:()=>void;onSignup:()=>void}){return <><div className="onboarding-actions"><button className="secondary" onClick={onBack}><ArrowLeft size={15}/> Back to website</button><button className="secondary" onClick={onSignup}>Create an account</button></div><div className="onboarding-foot"><Lock size={13}/> Paywai staff will never ask you for your password or a login code.</div></>}