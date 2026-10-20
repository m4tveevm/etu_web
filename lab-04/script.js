const form = document.querySelector('#contact-form');
const status = document.querySelector('#form-status');

form.addEventListener('submit', (event) => {
    event.preventDefault();
    status.textContent = 'The form is valid. This is a demo, so no data has been sent.';
    status.hidden = false;
});

form.addEventListener('input', () => {
    status.hidden = true;
    status.textContent = '';
});
