// Global variable to cache our source data
let fieldSourceData = new Map();

document.addEventListener('DOMContentLoaded', () => {
  const searchButton = document.getElementById('searchButton');
  if (searchButton) {
    searchButton.addEventListener('click', () => {
      const usernameInput = document.getElementById('username');
      const sobjectList = document.getElementById('sobjectList');
      const userName = usernameInput.value;
      const selectedObject = sobjectList.value;

      if (!userName) {
        setStatus('Please enter a user name.');
        return;
      }
      if (!selectedObject) {
        setStatus('Please select an SObject.');
        return;
      }
      
      setStatus('Checking...');
      getSalesforceSession(userName, selectedObject);
    });
  }

  populateSObjectList();
  setupHoverListeners();
});

async function getAuthInfo() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error("No active tab found.");

  const currentHost = tab.url.split('/')[2];
  const currentOrigin = `https://${currentHost}`;
  
  const isValidSalesforcePage = [
      '.lightning.force.com', '.vf.force.com', '.salesforce.com',
      '.my.salesforce.com', '.sandbox.my.salesforce.com', '.visual.force.com'
  ].some(domain => currentHost.endsWith(domain));

  if (!isValidSalesforcePage) {
      throw new Error('Please run this extension on a Salesforce page.');
  }
  
  let sessionCookie = await chrome.cookies.get({ url: currentOrigin, name: 'sid' });
  if (sessionCookie) {
      return { domain: currentOrigin, sessionId: sessionCookie.value };
  }

  let apiHost = currentHost.includes('.lightning.force.com') 
      ? currentHost.replace('.lightning.force.com', '.my.salesforce.com').replace('--c', '')
      : currentHost;
  
  const salesforceDomain = `https://${apiHost}`;
  
  if (salesforceDomain !== currentOrigin) {
      sessionCookie = await chrome.cookies.get({ url: salesforceDomain, name: 'sid' });
  }

  if (!sessionCookie) {
      throw new Error(`Session cookie not found at ${salesforceDomain}. Check manifest.`);
  }

  return { domain: salesforceDomain, sessionId: sessionCookie.value };
}

async function populateSObjectList() {
  const sobjectList = document.getElementById('sobjectList');
  try {
    setStatus('Loading SObjects...');
    const { domain, sessionId } = await getAuthInfo();
    const describeUrl = `${domain}/services/data/v58.0/sobjects/`;
    
    const data = await robustFetch(describeUrl, sessionId);
    data.sobjects.sort((a, b) => a.label.localeCompare(b.label));

    sobjectList.innerHTML = '<option value="">-- Select an SObject --</option>';
    data.sobjects.forEach(sobject => {
      if (sobject.queryable) {
        const option = document.createElement('option');
        option.value = sobject.name;
        option.textContent = `${sobject.label} (${sobject.name})`;
        sobjectList.appendChild(option);
      }
    });
    
    setStatus('Ready.');

  } catch (error) {
    console.error('Failed to populate SObject list:', error);
    setStatus(`Error: ${error.message}`);
  }
}

async function getSalesforceSession(userName, selectedObject) {
  try {
    const { domain, sessionId } = await getAuthInfo();
    setStatus('Fetching permissions...');
    fetchUserPermissions(domain, sessionId, userName, selectedObject);
  } catch (error) {
    console.error("Error in getSalesforceSession:", error);
    setStatus(`Error: ${error.message}`);
  }
}

async function fetchUserPermissions(domain, sessionId, userName, selectedObject) {
  const objectResultsDiv = document.getElementById('object-results');
  const fieldResultsDiv = document.getElementById('field-results');
  
  objectResultsDiv.innerHTML = '';
  fieldResultsDiv.innerHTML = '';
  fieldSourceData.clear(); 

  try {
    
    const escapedUserName = userName.replace(/'/g, "\\'");
    const userQuery = `SELECT Id, Name FROM User WHERE Username = '${escapedUserName}' OR Name = '${escapedUserName}' LIMIT 1`;
    const userResponse = await runDataQuery(domain, sessionId, userQuery);
    
    if (!userResponse.records || userResponse.records.length === 0) {
      setStatus(`Error: User not found with name or username '${userName}'.`);
      return;
    }
    const userId = userResponse.records[0].Id;
    const foundName = userResponse.records[0].Name;

    const assignQuery = `SELECT PermissionSetId, PermissionSetGroupId FROM PermissionSetAssignment WHERE AssigneeId = '${userId}'`;
    const assignRecords = (await runDataQuery(domain, sessionId, assignQuery)).records;

    const directPermSetIds = new Set();
    const groupIds = new Set();

    assignRecords.forEach(a => {
        if (a.PermissionSetGroupId) groupIds.add(a.PermissionSetGroupId);
        if (a.PermissionSetId) directPermSetIds.add(a.PermissionSetId);
    });

    
    if (groupIds.size > 0) {
        const groupList = Array.from(groupIds).map(id => `'${id}'`).join(',');
        const groupCompQuery = `SELECT PermissionSetId FROM PermissionSetGroupComponent WHERE PermissionSetGroupId IN (${groupList})`;
        const compRecords = (await runDataQuery(domain, sessionId, groupCompQuery)).records;
        compRecords.forEach(c => directPermSetIds.add(c.PermissionSetId));
    }

    if (directPermSetIds.size === 0) {
        setStatus(`No permission sets assigned to ${foundName}.`);
        return;
    }

    
    const targetIds = Array.from(directPermSetIds).map(id => `'${id}'`).join(',');

    
    const objectPermQuery = `SELECT PermissionsCreate, PermissionsRead, PermissionsEdit, PermissionsDelete, PermissionsViewAllRecords, PermissionsModifyAllRecords FROM ObjectPermissions WHERE SobjectType = '${selectedObject}' AND ParentId IN (${targetIds})`;
    
    
    const fieldPermQuery = `SELECT Field, PermissionsRead, PermissionsEdit, Parent.Label, Parent.IsOwnedByProfile, Parent.Profile.Name FROM FieldPermissions WHERE SObjectType = '${selectedObject}' AND ParentId IN (${targetIds})`;
    
    const describeUrl = `${domain}/services/data/v58.0/sobjects/${selectedObject}/describe`;

    
    const [objectPermData, fieldPermData, describeData] = await Promise.all([
      runDataQuery(domain, sessionId, objectPermQuery),
      runDataQuery(domain, sessionId, fieldPermQuery),
      robustFetch(describeUrl, sessionId)
    ]);

    
    const fieldMetadataMap = new Map();
    if (describeData.fields) { 
        for (const field of describeData.fields) { 
            fieldMetadataMap.set(field.name, { isUpdateable: field.updateable }); 
        } 
    }

    const effectiveObjectPerms = { Create: false, Read: false, Edit: false, Delete: false, ViewAll: false, ModifyAll: false };
    if (objectPermData.records) { 
        for (const record of objectPermData.records) { 
            if (record.PermissionsCreate) effectiveObjectPerms.Create = true; 
            if (record.PermissionsRead) effectiveObjectPerms.Read = true; 
            if (record.PermissionsEdit) effectiveObjectPerms.Edit = true; 
            if (record.PermissionsDelete) effectiveObjectPerms.Delete = true; 
            if (record.PermissionsViewAllRecords) effectiveObjectPerms.ViewAll = true; 
            if (record.PermissionsModifyAllRecords) effectiveObjectPerms.ModifyAll = true; 
        } 
    }

    const effectiveFieldPerms = new Map();
    if (fieldPermData.records) {
      for (const record of fieldPermData.records) {
        const fieldName = record.Field.split('.')[1];
        let perms = effectiveFieldPerms.get(fieldName) || { Read: false, Edit: false };
        if (record.PermissionsRead) perms.Read = true;
        if (record.PermissionsEdit) perms.Edit = true;
        effectiveFieldPerms.set(fieldName, perms);
        
        if (!fieldSourceData.has(fieldName)) { fieldSourceData.set(fieldName, []); }
        
        const sourceName = record.Parent.IsOwnedByProfile && record.Parent.Profile 
            ? record.Parent.Profile.Name 
            : record.Parent.Label;

        fieldSourceData.get(fieldName).push({ 
            name: sourceName, 
            isProfile: record.Parent.IsOwnedByProfile,
            read: record.PermissionsRead, 
            edit: record.PermissionsEdit 
        });
      }
    }

    
    setStatus(`Effective Permissions for ${foundName} on ${selectedObject}:`);
    
    
    objectResultsDiv.innerHTML = `
    <div class="object-perms-row">
        <div class="perm-item"><strong>Read</strong> ${createCheckbox(effectiveObjectPerms.Read)}</div>
        <div class="perm-item"><strong>Create</strong> ${createCheckbox(effectiveObjectPerms.Create)}</div>
        <div class="perm-item"><strong>Edit</strong> ${createCheckbox(effectiveObjectPerms.Edit)}</div>
        <div class="perm-item"><strong>Delete</strong> ${createCheckbox(effectiveObjectPerms.Delete)}</div>
        <div class="perm-item"><strong>View All</strong> ${createCheckbox(effectiveObjectPerms.ViewAll)}</div>
        <div class="perm-item"><strong>Modify All</strong> ${createCheckbox(effectiveObjectPerms.ModifyAll)}</div>
    </div>`;

    const fieldList = Array.from(effectiveFieldPerms.keys()).sort();
    let fieldHtml = '<table id="field-table">';
    fieldHtml += `<thead><tr><th>Field API Name</th><th>Read</th><th>Edit</th></tr></thead><tbody>`;
    
    for (const fieldName of fieldList) {
      const perms = effectiveFieldPerms.get(fieldName);
      const metadata = fieldMetadataMap.get(fieldName);
      const isEditModifiable = metadata ? metadata.isUpdateable : true;
      
      const fieldSetupUrl = `${domain}/lightning/setup/ObjectManager/${selectedObject}/FieldsAndRelationships/${fieldName}/view`;
      
      fieldHtml += `<tr>
        <td>
            <a href="${fieldSetupUrl}" target="_blank" class="icon-action setup-gear" title="Open in Setup">⚙️</a>
            <span class="source-hover-trigger icon-action source-info" data-field="${fieldName}" title="View Permission Source">ℹ️</span>
            <strong>${fieldName}</strong> 
        </td>
        <td>${createCheckbox(perms.Read, true)}</td>
        <td>${createCheckbox(perms.Edit, isEditModifiable)}</td>
      </tr>`;
    }
    fieldHtml += '</tbody></table>';
    fieldResultsDiv.innerHTML = fieldHtml;

  } catch (error) {
    setStatus(`Error: ${error.message}`);
    console.error('An error occurred:', error);
  }
}

// --- HELPER FUNCTIONS ---
async function robustFetch(url, sessionId) {
    const res = await fetch(url, { headers: { 'Authorization': `Bearer ${sessionId}` } });
    if (!res.ok) {
        let errorMsg = res.statusText;
        if (!errorMsg) {
             try {
                 const jsonBody = await res.json();
                 if (Array.isArray(jsonBody) && jsonBody.length > 0) errorMsg = jsonBody[0].message;
                 else errorMsg = JSON.stringify(jsonBody);
             } catch(e) { errorMsg = `Status ${res.status}`; }
        }
        throw new Error(errorMsg);
    }
    return res.json();
}

async function runDataQuery(domain, sessionId, query) {
    let records = [];
    let nextUrl = `/services/data/v58.0/query?q=${encodeURIComponent(query)}`;

    while (nextUrl) {
      
        const fullUrl = nextUrl.startsWith('http') ? nextUrl : `${domain}${nextUrl}`;
        
        const data = await robustFetch(fullUrl, sessionId);
        
        if (data.records) {
            records = [...records, ...data.records];
        }
        
        
        nextUrl = data.nextRecordsUrl;
    }
    
    return { records: records };
}

function setStatus(msg) {
    const el = document.getElementById('status');
    if (el) el.textContent = msg;
}

function createCheckbox(isChecked, isModifiable = true) {
  const className = isModifiable ? 'class="checkbox-blue"' : '';
  return `<input type="checkbox" ${isChecked ? 'checked' : ''} ${className} disabled>`;
}

function setupHoverListeners() {
  const popover = document.getElementById('popover');
  const popoverTitle = document.getElementById('popover-title');
  const popoverBody = document.getElementById('popover-body');
  const fieldResultsDiv = document.getElementById('field-results');

  if (!fieldResultsDiv) return;

  fieldResultsDiv.addEventListener('mouseover', (e) => {
    if (!e.target.classList.contains('source-hover-trigger')) return;
    
    const fieldName = e.target.dataset.field;
    const sources = fieldSourceData.get(fieldName);
    if (!sources) return;
    
    popoverTitle.textContent = `Permission Source: ${fieldName}`;
    let popoverHtml = '<table id="popover-table"><thead><tr><th>Source Name</th><th>Type</th><th>Read</th><th>Edit</th></tr></thead><tbody>';
    
    sources.sort((a, b) => { 
        if (a.isProfile) return -1; 
        if (b.isProfile) return 1; 
        return a.name.localeCompare(b.name); 
    });
    
    for (const source of sources) { 
        popoverHtml += `<tr><td>${source.name}</td><td>${source.isProfile ? 'Profile' : 'Permission Set'}</td><td>${source.read}</td><td>${source.edit}</td></tr>`; 
    }
    popoverHtml += '</tbody></table>';
    popoverBody.innerHTML = popoverHtml;
    
    let top = e.clientY + 5;
    let left = e.clientX + 10;
    if (left + 350 > window.innerWidth) { left = e.clientX - 360; }
    
    popover.style.left = left + 'px';
    popover.style.top = top + 'px';
    popover.style.display = 'block';
  });

  fieldResultsDiv.addEventListener('mouseout', (e) => {
    if (e.target.classList.contains('source-hover-trigger')) {
      popover.style.display = 'none';
    }
  });
}